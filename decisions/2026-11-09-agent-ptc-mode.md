# 行为设置：启用 PTC 模式（AgentTavern / 写卡工作台 / AgentNovel）

> 日期：2026-11-09。状态：已实施。相关：`decisions/2026-10-21-behavior-settings-section.md`（开关归置点）、`decisions/2026-11-02-agent-prompt-takeover.md`（complete 段）、`decisions/2026-10-09-workbench-novel-preset-projection.md`（兄弟投影通道）。

## 用户需求

「添加新行为设置：启用 PTC 模式。开启后所有 Agent 相关都启用 PTC 预设，也就是让原有的 AgentTavern、写卡工作台支持原生的 PTC 模式能力。」

PTC 是 DSH 原生工具面，不是另一套模型或预设内容：模型只看到保留的 `run_code` 工具和由当前可见工具生成的 SDK，所有子调用在宿主 PTC 运行时里执行。宿主形态有两条线：0.2.1 的 `dsh-tools` presentation seam（`presentAs`），以及 0.2.2+ 的 `@deepseek-ai/dsh-tool-executor-ptc` executor seam（`setExecutor`）。**所有 DSH 宿主交互都收口在 `packages/bind/src/ptc.ts`**；插件层只决定哪些会话启用 PTC。

## 决策

- **开关键**：`state.json` 的 `agentPtcMode?: boolean`，缺省关闭，读取一律 `=== true`。与 `nativeAgentPersona` / `nativeAgentPreset` 同款可选键，不进 `DEFAULT_STATE`，`...rest` 透传。
- **作用范围**：绑定的 `agent-tavern`（含 `agent-tavern-im`）、`agent-novel`、`card-workbench` 会话。`st` 不跑原生 AgentLoop；`agent-reasoning` 是内部受限子代理，保持原生工具面。
- **落点**：`packages/bind/src/ptc.ts` 拥有宿主 seam 探测、executor 模块装载、按 agent scope 挂载/卸载和 native 回退；`packages/plugin/src/agent-ptc-mode.ts` 只拥有行为开关、绑定架构、idle 调度和日志。
- **两条宿主线**：0.2.1 走 `ctx.inject(['tools', 'ptcRuntime'])` 后 `tools.presentAs('ptc')`；0.2.2+ 通过 `importHostPackage('@deepseek-ai/dsh-tool-executor-ptc')` 从宿主安装锚点装载同一模块，再由 `ctx.plugin(module)` 在 agent scope 调 `tools.setExecutor()`。executor 的 `setExecutor` disposer 只清空当前记录的 `executor`，不会删除 scope 记录；bind 在卸载后删除本插件拥有的记录，让选择回落到部署默认 native executor，避免 scope 变成 unavailable。
- **生命周期**：`agent/created`（宿主串行且 loop start 前 await）立即声明；三条绑定命令（AgentTavern / AgentNovel / CardWorkbench）与 IM preset 切换在绑定落盘后补声明；`agent/status(idle)` 与 `agent/disposed` 做对账；插件启动对 live 空闲 agent 做一次 `refreshAgentPtcMode`；状态路由写入后同样对账，并等待空闲 agent 的 `setExecutor` 完成后再返回。运行中的会话不中途翻转工具面：状态路由遇到 `running` 时先 `agent.whenIdle()` 排队，idle 后再对账，避免「状态写入晚于 turn start」时丢掉 idle 事件；关闭开关会卸载 executor/呈现层并恢复 native。`tools.resolve` 在 `agent/pre-step` 之前执行，所以任何插件（包括 preset 切换）都无法改写已经装配中的请求；能保证的是挂载立即完成、下一步骤装配立即反映。
- **不接管预设的 PTC**：如果 preset 或部署默认已经在父 scope 选中 PTC，`applyAgentPtcMode` 只做采纳，不再挂第二个 agent-scope executor；关闭开关也不会 dispose 预设的 executor。只有本插件拥有的 agent-scope 记录会在关闭时删除，父 scope 的 native/PTC 选择原样保留，避免「开关把预设顶掉」。如果 agent scope 已被别的插件占用，bind 拒绝第二次 `setExecutor` 且不触碰既有记录，运行时报告 `lastError`。
- **运行中门禁的归属**：只有插件层读 `agent.status`。bind 的 `mountPtc()` 不再读 `ctx.status`：真实 `agent.ctx` 是 Cordis Context 代理，访问未注入的服务名会抛 `cannot get property "status" without inject`，把每次挂载都误判为失败。
- **为什么不用 preset 行**：`@deepseek-ai/dsh-agent-tool-presentation` 是静态 profile YAML，运行时开关只能改写 profile 并重启；0.2.2 的 PTC executor 虽然也是 preset 行，但 bind 通过宿主包解析动态挂载同一模块到 agent scope，写状态时立即 `setExecutor`，不重置会话、不重挂预设。静态 PTC preset 变体只适合“整类预设永久 PTC”；宿主 `agentPresets.select` 对已开始会话直接拒绝（`lastTurn > 0`），无法拿来切换现有会话。

## AgentTavern 的 complete 段冲突

AgentTavern 的 `dsh-soulmojito:agent-prompt` 是 `complete: true`：宿主把它作为**唯一** system 段，PTC 注册/贡献的 `tools:sdk` 与 `tools:ptc-only` 会被丢弃。若只声明 PTC，模型会看到 `run_code` 却拿不到 SDK 与「只能调用 run_code」的规则。

处理：bind 的 `renderPtcCompleteText()` 在 complete 段文本里判定当前 seam 并渲染同一份文本追加到 system 头。0.2.1 用 `tools.modeFor(scope)` + `collapseSection()` / `sdkSection()`；0.2.2+ 用 `tools.selectExecutor(scope)` 取出当前 PTC executor 的 `sections`，以 `tools.definitions(scope, toolSet)` 作为 SDK 输入。native 或无 executor 时返回空串，保持原有字节稳定。

能力探测也放在 bind：`inspectPtcCapabilities()` 同步判断两条 seam，`inspectPtcCapabilitiesAsync()` 额外用 `importHostPackage` 预检 `@deepseek-ai/dsh-tool-executor-ptc` 可导入。缺少 seam、缺少 `ctx.ptcRuntime`、运行时语言没有 SDK 渲染器、或宿主包解析失败时，bootstrap 报 `agentPtc.available=false` 并给出具体原因，面板开关禁用；API 直接开启也会在写状态前拒绝。Fail-closed，不用「无 SDK 的 PTC」冒充可用能力。bootstrap 另带 `agentPtcRuntime`：逐绑定 agent 报告 `capable`、实际 `surface`（`ptc` / `native` / `unknown`）、是否已挂载和最后一次挂载错误，便于区分「宿主支持」和「这个 agent scope 没挂上」。

## 变更面

| 所有者 | 内容 |
|---|---|
| `packages/bind/src/ptc.ts` | 宿主 seam 探测、宿主包解析装载 executor、scope 挂载/卸载、native 回退、selected surface 诊断、complete 段 PTC 文本镜像 |
| `packages/plugin/src/agent-ptc-mode.ts` | 行为开关与绑定架构、每 agent 生命周期、`whenIdle` 收敛、live 对账与逐 agent 诊断 |
| `packages/plugin/src/mount.ts` / `index.ts` / `session/command.ts` / `http/novel.ts` / `im/runtime.ts` | 创建、绑定、IM 切换、启动对账 |
| `packages/plugin/src/http/panel-state-routes.ts` / `routes.ts` / `read-routes.ts` | `agentPtcMode` 写入白名单、可用性门禁、即时对账、bootstrap 能力 |
| `packages/tavern-store/src/store.ts` | 可选状态键 |
| `client-src/83-ui-prompts.js` / `40-i18n-en.js` / `41-i18n-zh.js` | 行为设置开关、提示与不可用原因 |
| `packages/plugin/src/agent-tavern/agent.ts` | complete 段追加 PTC 文本；提示词查看器同步记录 |

## 验证

- 新增 `packages/bind/tests/ptc.spec.ts`：0.2.1/0.2.2 能力探测、宿主包导入预检、complete 文本镜像、两条 seam 的挂载/卸载与 native 回退、Cordis 代理属性回归。
- 新增 `packages/plugin/tests/agent-ptc-mode.spec.ts`：绑定架构门禁、开关翻转的生命周期、live 对账、运行中会话等空闲后才翻转。
- `behavior-settings-client.spec.ts` 增加开关 marker 与 zh/en 文案键。
- `tsc -b`、`vitest run`、`node scripts/build-plugin.mjs`、`node packages/plugin/scripts/gates/run.mjs` 全绿。

## 已知边界

- PTC 模式改变模型可见工具面（只剩 `run_code`），会从第一个变化的 prompt/schema token 起让前缀缓存失效；这是切换模式的预期成本。
- 若 Profile 给同一 scope 额外挂载了 `dsh-tool-executor-native` / `dsh-tool-executor-ptc` 行，0.2.2 的「一个 scope 一个 executor」守卫会拒绝 bind 的第二次挂载；bind 报明确 warning，该会话保持预设自带的 executor。
- 运行时语言不在 `typescript` / `python` 时视为不可用，等待宿主 SDK 渲染器补齐后再放开。
