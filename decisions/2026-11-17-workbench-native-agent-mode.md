# 行为设置：写卡工作台解锁原生 Agent 全能力（CardWorkbench Native）

> 日期：2026-11-17。状态：已实施。相关：`decisions/2026-11-17-workbench-inventory-and-audition.md`（同批库存改造）、`decisions/2026-11-10-im-native-agent-mode.md`（参照实现）、`decisions/2026-10-11-workbench-reference-read.md`（工作台文件工具行）。

## 用户需求

「再添加一个行为设置，写卡工作台解锁完整 Agent 能力，参考 IM 的实现。」

写卡工作台当前 preset `card-workbench` 只挂 24 件写卡工具 + 一行只读文件工具，没有
标准 DSH Agent 的 shell、文件搜索、后台任务、定时、技能、目标、子代理、待办、
网页等能力。用户要在显式开关下把工作台会话扩成完整原生 Agent 工具面，同时保留
写卡方案/确认协议与工作台内核。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/cordis.patch.yml`（新 preset 行）、`src/card-workbench/preset-ids.ts`（preset 选择）、`src/card-workbench/preset-reconcile.ts`（生命周期收敛）、`src/http/novel.ts`（workbench-open 选目标）、`http/panel-state-routes.ts` + `client-src/83-ui-prompts.js` + i18n（开关）、`tavern-store`（状态键） |
| 唯一事实来源 | `state.json` 的 `cardWorkbenchNativeAgentMode` 决定目标 preset；`card-workbench-native` 的 plugins 列表是工具面的声明式事实来源 |
| 持久态 | `cardWorkbenchNativeAgentMode?: boolean`，缺省关闭；读取一律 `=== true`。会话日志的 `agent-preset/selected` 记录实际目标 preset |
| 临时态 | 无新增；running 会话等 `agent/status(idle)` 或下一次 `agent/created` 再切，失败只记日志 |
| 外部依赖 | 宿主 `@deepseek-ai/dsh-agent-preset`（recompose）与 standard/IM-native 同款工具包；`dsh-card-workbench` 自身 bundle |
| 注册入口 | 面板「行为设置 → 会话行为」开关；`POST /state` 白名单；`workbench-open` 命令；`agent/created` / `agent/status(idle)` / 启动 sweep / 面板写状态后 reconcile 四个收敛点 |
| 删除路径 | 删 `preset-card-workbench-native` 行 + `cardWorkbenchNativeAgentMode` 键 + 开关 UI + `preset-reconcile.ts` 挂载；关闭开关时 live 会话切回 `card-workbench`；旧 state 缺键即关闭 |
| 兼容对象 | 默认关闭，既有 `card-workbench` 行为不变；绑定 schema 不变；`agentPtcMode` 仍正交；PTC 作用域已覆盖 card-workbench |

## Decision

1. **两个 preset，不做运行时拼装**：`card-workbench` 保持写卡-only；新增
   `card-workbench-native`（`config.id = card-workbench-native`），组合
   `dsh-soulmojito/card-workbench` + standard 同款工具行（shell/files/search/
   jobs/schedule/skills/goals/subagents/todo/web/present）。文件工具只声明一行
   `tool-fs`（默认 read/write/edit），不重复原 preset 的只读行。
2. **开关只选目标 preset**：`workbench-open` 读 `state.cardWorkbenchNativeAgentMode`
   选择 `card-workbench-native` / `card-workbench`；`ensureAgentPresetDeclared`
   检查目标行，marker 也按目标写。绑定、目标资产、开场提示与确认协议完全不变。
3. **live 收敛**：新增 `mountCardWorkbenchPresets`。`agent/created`、`agent/status(idle)`、
   插件启动 sweep 与 `POST /state` 写后都调用同一 `applyCardWorkbenchPreset`；
   只处理 `sessionBindings[sessionId].architecture === 'card-workbench'` 的会话，
   running 跳过等 idle。切完 best-effort 补 PTC 呈现。
4. **UI 与状态**：开关放在「行为设置 → 会话行为」IM native 旁边，按 `=== true`
   读取；文案明确 shell/文件写入/联网风险与「与 PTC 正交」。`POST /state`
   白名单接受该键，写后立即 reconcile。
5. **门禁**：`patch-reference` 增加两个 card-workbench preset 行与
   `card-workbench-native` 常量检查，防止 patch 与产物漂移。

## Alternatives considered

- **直接把标准工具行塞进 `card-workbench`**：所有工作台用户无条件获得 shell/联网，
  违背默认最小权限；否决。
- **运行时动态拼装工具面**：宿主 preset 是声明式组合，运行时按 id 选择是 IM 已验证的
  稳定路径；动态拼装会绕过宿主工具注册与权限面；否决。
- **只切新会话，不做 live 收敛**：用户翻转开关后旧工作台会话仍缺工具，必须重开；
  IM 已有 live 收敛先例，补齐成本低；否决。
- **把 PTC 并入同一开关**：PTC 只改变呈现方式，IM 决策已明确正交；保持独立。

## 验证

- `tavern-command.spec.ts`：开关开 → `workbench-open` 写 `card-workbench-native`
  marker；关 → 新会话回到 `card-workbench`。
- `card-workbench-p3.spec.ts`：live bound + idle 会话切到 native；running 会话不动。
- `behavior-settings-client.spec.ts`：开关 marker 与 zh/en 文案键。
- `pnpm run check`：typecheck、全量 vitest、bundle 构建与 gates 全绿。

## 已知边界

- `card-workbench-native` 的工具行是 DSH 0.2.2 线 standard preset 的静态快照；
  宿主新增标准工具时需同步该行，由 `preset-host-rows` gate 锁定。
- 开关打开后工作台获得 shell、文件写入与联网权限，属于显式信任扩展；默认关闭。
- 运行中的工作台会话首轮仍用旧工具面，idle 后收敛；宿主不提供热替换正在跑的 turn。