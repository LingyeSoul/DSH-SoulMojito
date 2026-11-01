# 决策：AgentTavern 接管整份 system prompt（complete 段）

> 日期：2026-11-02。状态：已实施。相关：`decisions/2026-10-11-agent-prompt-viewer.md`（预注入面）、`decisions/2026-10-09-agent-preset-cache-stability.md`（前缀缓存纪律）、`decisions/2026-10-11-prompt-viewer.md`（记录纪律）、`packages/plugin/src/agent-tavern/prompt-parts.ts`（新模块）。

## 背景与问题

用户发现：Agent 模式（AgentTavern / AgentTavernIM）会话里，最终发往模型的 System Prompt 除了本插件的 kernel 与 preset，还带着一整份 DSH 宿主提示词。

实测（本机 v4 会话日志的 `system/message` 事件；`surfaceOp=replace` 保证 surface 上始终只有一个 system 节点）：

- 标准 AgentTavern 会话（seq 23）6727 字符：宿主 3999（59.5%），本插件 2728（40.5%）；
- AgentTavernIM 会话（seq 847）8550 字符：宿主 3999（46.8%），本插件 4551（53.2%）。

宿主那 3999 字符由五处注册拼出：

| 段 | 来源 | 字符 |
|---|---|---|
| `harness:identity`（You are an AI agent powered by DeepSeek Harness.） | `@deepseek-ai/dsh-system-prompt` | 48 |
| `deployment:persona-prefix`（You are a coding agent powered by … model.） | web profile 的 `system-prompt.config.personaPrefix` | 76 |
| web 搜索偏好 + 图片附件限制 | profile 插件 `dsh-rider` 的两个全局 section | 1244 |
| present 结果展示指引 | `@deepseek-ai/dsh-client-ui-deliverables` | 1304 |
| harness 源码 checkout + Web GUI URL 指引 | `@deepseek-ai/dsh-harness-dev-context` | 1327 |

不是重复注入：每段各出现一次，surface 上只有一份 system（replace 链 8→24→397→686→847）。问题是宿主那份**从未被替换**——插件只做加法，而宿主的 `assemble()` 会合并全局层与 agent scope 层的全部 section。

其中 `harness-dev-context` 是「如何检视/扩展 harness」的开发话术，`persona-prefix` 把模型称作 coding agent——对角色扮演会话是身份冲突加纯 token 浪费。

## 决策

用宿主原生的 `complete: true` 接管：AgentTavern 的 agent bundle 注册**唯一**一个 complete 段。宿主 `assemble()` 的语义是「complete 段成为最终 sections 的唯一成员」（`sections: [completeSection]`），其余 section 全部丢弃；同一 scope 出现多个 complete 段会直接抛错。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/src/agent-tavern/prompt-parts.ts`（新，跨 bundle 部件注册表）、`agent-tavern/agent.ts`（唯一 complete 段 + 部件注册）、`im/agent.ts`（IM 段改为部件）、`mods/agent-mount.ts`（`promptSections` 选项）、`prompt-viewer.ts`（section 的 `scope` 字段）、`client-src/83-ui-prompts.js` + 40/41 i18n |
| 唯一事实来源 | system 头 = complete 段文本（部件注册表按 order 求值，mod 段从 `modSectionSnapshot()` 并入）；动态上下文 = 宿主 `systemPrompt.context()` 的 runtime snapshot |
| 持久态 | 无新增持久态；预设冻结记录（frozenAt/seed）与懒装载缓存的既有语义不变 |
| 临时态 | 部件注册表（globalThis，跨 bundle 互见）；mod 段仍是 live 快照；重启由模块加载重建 |
| 外部依赖 | 宿主 `HostPromptSection.complete`（0.2.1-rc.2 实测语义）；`@deepseek-ai/dsh-persona` 用同一 seam 替换 persona |
| 注册入口 | agent bundle 的 `ctx.systemPrompt.section`：`dsh-soulmojito:agent-prompt`，order -80，`complete: true` |
| 删除路径 | 去掉 `complete` 标记并恢复 kernel / preset 两条独立 section 注册即可回旧形态；IM 段改回 `systemPrompt.section`；`agent-prompt-takeover.spec.ts` 会翻红提醒 |
| 兼容对象 | ST 架构、AgentNovel、CardWorkbench 零变化（它们不挂 agent bundle）；mod 段在 novel 仍走宿主 section（`promptSections: 'host'`） |

## 落法

- **跨 bundle 部件注册表**：agent.mjs 与 im-agent.mjs 是 esbuild 各自打包的死产物，模块级 Map 不互见。部件经 `globalThis[Symbol.for('dsh-soulmojito:agent-prompt-parts')]` 注册（与 mod-registry 同学科），agent bundle 的 complete 段在装配时按 order 拼装。IM 段（-90）因此仍在 kernel（-80）之前。
- **只保留一个 complete 段**：`agent-tavern-im` preset 同时挂载 agent 与 im-agent 两行，但只有 agent bundle 注册段；IM bundle 只贡献文本，否则它的 section 会被 complete 丢弃、IM 规则静默消失。
- **context 通道不动**：facts / guides / script / games 本来就是 `systemPrompt.context()`——宿主把它们渲染进每步的 runtime snapshot（一条 user 消息），不属于 system 头。complete 接管只影响 section；`suppressRuntimeContext()` 会连带删掉这四个动态通道，因此不用。
- **mod 段**：agent bundle 不再把 mod section 注册成宿主 section（会被 complete 丢弃），改为在装配时并入 `modSectionSnapshot()`（同一份 order 钳制 + `hostPromptSafe`）；novel bundle 仍走宿主 section。
- **查看器如实标注**：部件新增 `scope`（`system` / `context`），面板在 context 部件的行尾标 `· context`；记录的 `system` 只拼 system 头部件。
- **前缀缓存**：complete 段仍是 system 头，preset 的冻结时钟/种子纪律不变；宿主提示词消失只会缩小头部，不引入新的字节抖动。

## 否决项

- **waterfall 过滤 `system-prompt/assemble`**：能只摘宿主段并保留多段结构，但依赖未进入 `host-contract` 的宿主内部事件；且 `completeSection` 在 waterfall 之前捕获、监听器无法改写它，收益不如原生 complete 明确。
- **profile 层收口**：`includeHarnessIdentity: false`、清空 `personaPrefix`、给 `dsh-rider` 的全局段加门控——只影响本机配置，插件用户拿不到；且 `dsh-*` 几段仍摘不掉。
- **不管**：身份冲突（coding agent vs AgentTavern）加每轮约 4000 字符的无效头部，不可接受。

## 已知边界

- 宿主工具（fs / bash / web / present 等）仍在工具目录里，但它们的**文字指引**不再进 system prompt；AgentTavern 的工具用法由 kernel 与各工具 description 承担。
- 运行中的会话在新代码生效后第一次装配会整块换掉 system 头，前缀缓存一次性作废——与插件升级同款代价。
- 若将来有别的 preset 插件在同一 scope 注册 complete 段，宿主会抛 `multiple complete prompt sections are active`——这是宿主的显式契约，不允许静默共存。
- 提示词查看器记录的是部件文本；宿主投影的历史仍不可见（`promptTokens` 只覆盖预注入面）。

## 验证

- 新增 `packages/plugin/tests/agent-prompt-takeover.spec.ts`：唯一 complete 段；system 部件按 order 拼装（IM -90 在 kernel 前、只出现一次）；空部件摘除；context 部件不进 system 头；mod 段钳制 [-50, 0] + `{{...}}` 中性化 + 排在 kernel 之后；读取面 `scope`。
- 更新：`agent-tavern-mount`（唯一 section + complete）、`agent-prompt-viewer`（覆盖面锁改为「apply 注册面 vs 部件注册面」双向对账 + scope）、`im-agent-preset`（部件注册、不再碰宿主 section）、`tavern-mods`（mount 选项）、`agent-tavern-preset` / `prompt-safety` / `tavern-command` / `agent-tavern-mvu-settle` / `tavern-guides`（读取面改为部件注册表）。
- 全量 `vitest run`（197 文件 / 3268 通过 / 2 skip）、`node packages/plugin/scripts/gates/run.mjs`（`mod-loader` 改为探测 complete 段与读取面）与 `pnpm build:plugin` 通过。

## 影响面

- Agent 模式 system prompt 由实测 6727 / 8550 字符降到约 2728 / 4551 字符；宿主 identity、deployment persona、工具与界面指引不再进入。
- ST 架构、AgentNovel、CardWorkbench、IM 工具面零变化。
- 提示词查看器新增 `scope` 字段，面板 i18n 由「预注入 system 片段」改为「预注入片段」。
