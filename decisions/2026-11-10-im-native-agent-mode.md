# 行为设置：IM 模式解锁原生 Agent 全能力（与 PTC 正交）

> 日期：2026-11-10。状态：已实施。相关：`decisions/2026-10-31-im-native-session-binding.md`（IM 绑定原生会话）、`decisions/2026-11-09-agent-ptc-mode.md`（PTC 呈现开关）、`decisions/2026-10-21-behavior-settings-section.md`（开关归置点）。

## 用户需求

「为 IM 模式添加新的行为设置，解锁原生的全部 Agent 能力，而且和 PTC 模式开关不冲突。」

IM 绑定当前会把会话 `recompose` 到 `agent-tavern-im`，该 preset 只挂 AgentTavern 与 IM 提示，没有标准 DSH Agent 的工具面。于是「IM 模式」等于把会话的原生 shell、文件、搜索、任务、技能、子代理等能力整体换掉。新开关要把这层锁打开，同时保持 IM 回复规则。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/cordis.patch.yml`（新 preset 行）、`src/im/runtime.ts`（目标 preset 选择）、`src/agent-ptc-mode.ts`（PTC 作用域）、`src/im/types.ts`（preset id 常量）、`tavern-store`（状态键）、`http/panel-state-routes.ts` + `client-src/83-ui-prompts.js` + i18n（写入与开关） |
| 唯一事实来源 | `state.json` 的 `imNativeAgentMode` 决定目标 preset；`agent-tavern-im-native` 的 plugins 列表是工具面的声明式事实来源 |
| 持久态 | `imNativeAgentMode?: boolean`，缺省关闭；读取一律 `=== true`。会话日志里的 `agent-preset/selected` 仍记录实际选中的 preset，宿主重启按它恢复 |
| 临时态 | 无新增；运行中切预设失败只留在 IM 运行日志，等 `agent/created` / `agent/status(idle)` 重试 |
| 外部依赖 | 宿主 `@deepseek-ai/dsh-agent-preset`（`recompose`）与标准 preset 同款工具包（`dsh-tool-bash/pwsh/fs/fs-search/jobs/schedule/skill/goal/subagent/workflow/ask-user/todo/web/present`） |
| 注册入口 | 面板「行为设置 → 会话行为」开关；`POST /state` 白名单；IM 绑定、`agent/created`、`agent/status(idle)`、启动 sweep 四个既有入口 |
| 删除路径 | 删 `preset-agent-tavern-im-native` 行 + `imNativeAgentMode` 键 + 开关 UI + 目标选择分支；关闭开关时运行中的会话会自动切回 `agent-tavern-im`；旧 `state.json` 缺键即关闭 |
| 兼容对象 | 默认关闭；既有 `agent-tavern-im` 行为不变；novel/workbench/ST 仍拒绝自动切预设；PTC 开关与预设工具集合互不覆盖 |

## 决策

- **两个 preset，而不是一个动态拼装**：`agent-tavern-im` 保持 Tavern-only；新增 `agent-tavern-im-native`（`cordis.patch.yml`，`config.id = agent-tavern-im-native`），组合 `dsh-soulmojito/agent` + `dsh-soulmojito/im-agent` + 标准 preset 的工具行。宿主 preset 是声明式组合，运行时按 id 选择是最稳定的路径；不复制宿主 profile 之外的私有能力。
- **工具行与 standard 同款**：shell（bash/pwsh 按平台 `!!js` 禁用）、文件读写、文件搜索、后台任务、定时、技能、目标、子代理/工作流、待办、网页、present。`persona` / `agent-instructions` / `time-context` 是纯 prompt section，会被 AgentTavern 的 complete 段丢弃，故不声明；compaction 继续由 profile 级 `tavern-compaction` 提供，保留 RP 检查点摘要。
- **开关只选目标 preset**：`applyPresetToAgent` 读 `state.imNativeAgentMode`，在 `agent-tavern-im-native` / `agent-tavern-im` 之间选择；当前 marker 已是目标时幂等。绑定、启动、idle 重试全部走同一函数，因此关掉开关也会在空闲后自动切回。
- **PTC 不参与选择**：`agentPtcMode` 只决定工具面的呈现方式（`run_code` + SDK vs 原生 schema），不改变目标 preset，也不因新开关被清除。两者同时开启时，`im-native` 的全部工具进入 PTC SDK。
- **PTC 作用域补齐 IM 绑定会话**：此前 PTC 只看 `state.sessionBindings` 的架构，IM 绑定的标准 DSH 会话没有 Tavern 绑定，因而拿不到 PTC。`isPtcScope()` 现在把「任意 IM peer 绑定的 session」纳入，排除 ST；这样新开关与 PTC 开关可以任意组合，不会出现「开了 IM 原生能力，PTC 却静默不生效」。
- **启用即收敛**：`POST /state` 写 `imNativeAgentMode` 后调用 `ImRuntime.ensurePresets()` 重选 live 空闲会话，再 `refreshAgentPtcMode()` 对账；运行中/未打开的会话由既有生命周期重试点补齐。

## 变更面

| 所有者 | 内容 |
|---|---|
| `packages/plugin/cordis.patch.yml` | `preset-agent-tavern-im-native` 声明（标准工具行 + Tavern + IM 提示） |
| `packages/plugin/src/im/types.ts` | `AGENT_TAVERN_IM_NATIVE_PRESET_ID` |
| `packages/plugin/src/im/runtime.ts` | 目标 preset 选择、日志、`ImPresetSwitchResult.preset` |
| `packages/plugin/src/agent-ptc-mode.ts` | `PtcAgentLike`、`isPtcScope`（Tavern 架构或 IM 绑定，排除 ST）、诊断签名 |
| `packages/plugin/src/http/panel-state-routes.ts` / `read-routes.ts` | 状态键白名单、写后收敛、PTC 诊断传完整 state |
| `packages/tavern-store/src/store.ts` | 可选状态键 |
| `client-src/83-ui-prompts.js` / `40-i18n-en.js` / `41-i18n-zh.js` | 行为设置开关、提示与安全警告 |
| `packages/plugin/scripts/gates/run.mjs` | preset 行与构建产物常量门禁 |

## 验证

- `im-preset-switch.spec.ts`：开关开 → `agent-tavern-im-native`；关 → 切回 `agent-tavern-im`；既有默认关闭用例保持。
- `agent-ptc-mode.spec.ts`：IM 绑定的标准会话（无 `sessionBindings`）获得 PTC；IM 绑定的 ST 仍被排除；`imNativeAgentMode` 写路由不受 PTC 可用性影响。
- `behavior-settings-client.spec.ts`：开关 marker、zh/en 文案键。
- `tsc -p packages/plugin`、`vitest` 目标切片、`scripts/build-plugin.mjs`、`gates/run.mjs` 全绿。

## 已知边界

- `agent-tavern-im-native` 的工具行是 DSH 0.2.1 线 standard preset 的静态快照。宿主后续新增标准工具时需要同步该行；缺失的宿主包会让 preset 激活失败，开关可随时关回。
- 计划模式（`planning` group）未纳入：它的规则依赖标准 preset 的 system section，而 AgentTavern 的 complete 段会丢弃该 section；半挂载的计划模式比没有更危险。
- `agent-novel` / `card-workbench` / `st` 仍不自动切换；它们有各自完整的工具与提示面。
- 开关打开后，IM 会话获得 shell、文件写入与联网权限。这是用户显式授权的信任扩展，UI 已写明风险；默认关闭。
