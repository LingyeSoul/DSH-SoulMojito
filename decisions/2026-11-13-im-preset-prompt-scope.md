# IM 预设提示词不得泄漏到普通 AgentTavern 会话

日期：2026-11-13。相关：`decisions/2026-11-02-agent-prompt-takeover.md`、`decisions/2026-10-31-im-native-session-binding.md`、`packages/plugin/src/agent-tavern/prompt-parts.ts`、`packages/plugin/src/agent-tavern/agent.ts`、`packages/plugin/src/im/agent.ts`、`packages/plugin/src/im/types.ts`。

## 问题

证据会话（`2026-11-13@16h 46m 26s 172ms`，记录 preset 为 `agent-tavern`）在首个真实模型请求（turn 23）的 system 头里出现了 `# IM 模式（AgentTavernIM）` 整段；该会话是本地普通角色扮演，没有任何 IM peer 绑定。同进程内早前打开过 IM 绑定会话（其 preset 为 `agent-tavern-im-native`）。

## 根因

1. `prompt-parts.ts` 的部件表锚在 `globalThis`（跨 esbuild bundle 互见），生命周期等于**整个宿主进程**，不是单个 agent 或 preset。
2. `im/agent.ts` 在模块加载期注册 `dsh-soulmojito:im-mode`；只要本进程曾经挂载过任一 IM preset（`agent-tavern-im` / `agent-tavern-im-native`），该部件就永久留在表里。`apply()` 不返回反注册，模块级注册也无法跟随 preset 卸载。
3. IM 部件的 `text` 回调忽略 agent 身份，对任何装配都返回整段 IM 规则。
4. agent bundle 的 complete 段求值部件时只传 `agentId`，没有预设身份可用于收窄。

结果：进程内第一次挂载 IM preset 之后，所有 AgentTavern 会话的 system 头都会带上 IM 段。证据会话的 turn 1 没有模型请求（导入期只有消息帧），turn 23 是首个真实请求，因此泄漏在该轮才暴露。

## 方案

- `AgentPromptPart.text` 签名扩为 `(agentId, presetId)`；`agentPromptPieces` / `agentPromptSectionsFor` / `agentSystemPromptTextOf` 全链路显式传递 preset id（`prompt-parts.ts:35`、`agent.ts:535`）。
- `agent.ts` 声明 `agentPresets` inject，并在装配期解析当前 agent 的 preset：优先宿主 session 投影 `presetForSession`（覆盖创建时 header 带预设的会话），退回 `composedPreset(agent.ctx)`，最后退回日志最后一条 `agent-preset/selected`（`agent.ts:511`）。解析不到时按「非 IM preset」处理——安全收窄方向。
- `im/types.ts` 提供 `isAgentTavernImPresetId`，只认声明过的两个 IM preset id；`im/agent.ts:95` 的部件文本按该判定返回正文或空串。空文本会被注册表摘除，普通会话零 token 变化。
- 提示词查看器同步使用同一 preset id，避免「实际 system 头正确、查看器仍显示 IM 段」的假象。

不采用「apply 返回反注册」：部件是进程级共享的，任一 IM 会话仍在线时反注册会把其它 IM 会话的规则一起拿走；泄漏问题也不会消失。

## 验证

- `packages/plugin/tests/im-agent-preset.spec.ts`：`agent-tavern` / `agent-novel` / `card-workbench` / 未知 preset 取不到 IM 部件；两个 IM preset 仍返回原文。
- `packages/plugin/tests/agent-prompt-takeover.spec.ts`：complete 段按 session 投影的 preset 收窄——普通会话文本不含 IM 段，IM 会话文本含 IM 段。
- 既有 preset 切换、提示词查看器、游戏段测试全量通过。

## 遗留边界

自定义 preset 若手动组合 `dsh-soulmojito/im-agent`，不会自动获得 IM 段（只认官方两个 id）。IM 绑定流程只切换到这两个 preset，自定义组合不在支持面内；如将来需要，应改为按 composition 判定，而不是维护第二份 id 表。