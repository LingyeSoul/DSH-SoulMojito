# 决策：AgentTavern 预设投影（提示词块 + temperature）

> 日期：2026-10-09。状态：已实施。相关：提案 0004（AgentTavern 架构）、0009（guides 注入范式）、0014，`src/agent-tavern/preset.ts`。

## 背景与根因

AgentTavern 复用宿主 AgentLoop，ST 生成路径仍持有插件自己的 prompt 装配与 LLM 调用；但在修复前，激活预设没有任何进入 AgentLoop 的通道：

- `packages/tavern-pipeline` 的 `assemblePrompt` 只被 ST 的 `runGeneration` 调用，AgentTavern 侧只有 `agent.ts` 注册的 kernel / facts / guides / script 四段；
- 预设的 `prompts[]` / `prompt_order[]` / 采样参数在 AgentTavern 会话里完全不参与装配。

用户视角即「AgentTavern 模式下预设完全不生效」：换了预设、改了提示词、调了温度，对原生会话没有任何影响。

## 决议：各成分的映射

| 预设成分 | AgentTavern 处理 |
|---|---|
| 内容型提示词（`main`、自定义、`jailbreak`） | 注入 agent 作用域 systemPrompt section `dsh-tavern:agent-preset`（order -75：kernel 之后、facts 之前），按 `prompt_order`（优先 dummy 100000 组）顺序拼接 |
| 卡覆盖语义 | 与 ST 管线一致：`main` ← 卡 `system_prompt`、`jailbreak` ← 卡 `post_history_instructions`；空串回落预设内容，`{{original}}` 引用预设原文 |
| marker（charDescription / charPersonality / scenario / personaDescription / dialogueExamples / worldInfoBefore/After / chatHistory） | 不进固定 prompt：由会话级工具、原生历史与可选预载承接（提案 0004 §5 的既有边界） |
| `temperature` | `agent/request` waterfall 覆盖（宿主 model seat 不暴露温度，预设是用户唯一的调温入口） |
| `openai_max_context` / `openai_max_tokens` | 宿主所有：请求容量由实际 provider/model route 与 DSH pressure policy 决定（提案 0004 §8）；在工具循环里按 ST「响应长度」硬切输出上限会截断 tool-call，得不偿失 |
| 角色为 `user`/`assistant` 的内容提示词 | 折叠进同一 system 块（AgentLoop 没有逐条消息注入的 seam；保留内容，不保留角色通道） |

**启用语义**（三种用户可触达的禁用信号任一显式 false 即不注入）：`prompt_order[].enabled`（ST 原生）、`prompt.enabled`（写卡工作台约定）、`prompt.system_prompt`（Tavern 面板「启用」开关）。用户显式关掉的提示词绝不静默注入；无 `prompt_order` 时与 ST 一致——不注入任何提示词。

**回落**：未选择激活预设时与 ST 生成路径共用内置默认预设（面板显示为「内置角色扮演预设」，`temperature: 1`）。

## 装载、写穿与首轮正确性

- 与 facts/guides 同款 best-effort 异步装载：首次为某 agent 装配时异步读一次，装载完成前返回空串；写穿刷新用票号 last-write-wins，防在途过期装载覆盖新写入。
- 文本进宿主前过 `prompt-safety.ts`：ST 宏（`{{char}}`/`{{user}}`）展开 + 残留 `{{...}}` 中性化（预设是 ST 宏的高频来源，原文进 section 会让宿主 interpolate 抛错中止装配）。
- **失效信号跨 bundle 共享**：emit 在 `index.mjs`（state/preset CRUD 路由）与 `card-workbench.mjs`（`preset_put`），监听在 `agent.mjs`。分离 bundle 各持一份模块级 Set 会互不可见，注册表用 `Symbol.for('dsh-tavern:agent-preset-changed-listeners')` 锚定在 `globalThis`（同学科于 agent-novel/usage.ts）。同修 `guides.ts` 的写穿注册表——它跨 bundle 静默失效过（emit 侧与监听侧同款分裂）。
- **激活预热**：激活命令在 `bindSession` 之后 emit 一次，首轮装配就带预设；否则首轮请求在异步装载完成前拿到空串，用户看到的现象仍是「不生效」。

## 变化与代价

- AgentTavern 会话的 system prompt 每轮多一段预设内容（token 成本随用户配置，与 ST 一致地不做硬性截断）。
- `temperature` 开始跟随激活预设（含内置默认预设的 1）——宿主 model seat 的 provider/model/Effort 选择不受影响。
- ST 管线、群聊与写卡工作台行为不变：本决策只影响 AgentTavern 原生会话的装配。

## 边界与已知偏差

- **EJS 模板不进入预设文本通道**：ST 路径经 `preRenderPreset` 对预设执行 `<% %>`（提案 0008），AgentTavern 投影不做模板渲染——使用 Prompt Template 的预设会以模板原文进入 section。接入需在 agent 侧重复模板运行时装配，另行处理。
- **regex 不作用于预设文本**：两架构一致（ST 管线也只对世界书与消息应用 regex）。
- **采样只投影 temperature**：`openai_max_context` / `openai_max_tokens` 归宿主（理由见上表）。
- **ST 管线继续忽略 `prompt_order[].enabled`**：ST 侧装配没有启用过滤，属既有状态；AgentTavern 投影按启用语义注入，两侧在此点上暂不一致。

## 验证

- `packages/plugin/tests/agent-tavern-preset.spec.ts`：启用语义（slot/prompt/面板三信号）、marker 与空内容跳过、卡覆盖与 `{{original}}`、-75 section 注册与懒装载（宏展开 + 无 `{{` 残留）、`agent/request` 温度覆盖与未绑定透传、state/PUT/DELETE 路由写穿、跨模块实例共享注册表（vi.resetModules 模拟分离 bundle）。
- `packages/plugin/tests/tavern-command.spec.ts`：激活预热回归（临时移除 emit 后该用例变红，敏感性已验证）。
- `packages/plugin/tests/tavern-guides.spec.ts`：guides 注册表跨实例共享回归。
