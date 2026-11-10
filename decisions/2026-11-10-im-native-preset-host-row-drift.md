# AgentTavernIM Native 预设加载失败：宿主行按 0.2.2 口径重写

> 日期：2026-11-10。状态：已实施。相关：`decisions/2026-11-10-im-native-agent-mode.md`（本预设的引入决策）、`decisions/2026-11-10-dsh-022-rc1-verification-runtime.md`（宿主升到 0.2.2-rc.1）。

## 用户需求

「修复 AgentTavernIM Native 报错。」面板里的预设卡显示加载失败，错误行是：

```
tool-subagent-list-agents (@deepseek-ai/dsh-tool-subagent-control/list-agents): never started
```

## Problem

`agent-tavern-im-native` 在宿主 `0.2.2-rc.1` 上完全挂不起来：声明里有一行指向宿主包子路径，而该子路径在当前宿主线已不存在。

### RCA 证据

| 证据 | 内容 |
|---|---|
| 报错语义 | `never started` 来自 `@deepseek-ai/dsh-agent-preset-registry` 的 `auditRows()`：`entry.fiber === undefined` 即该行从未被 loader 装载；它只在**模块解析/导入失败**时出现，不是等服务的 `pending`。 |
| 宿主导出表 | `@deepseek-ai/dsh-tool-subagent-control@0.2.2-rc.1` 的 `exports` 只有 `.`、`./src/*`、`./package.json`、`./locale/*.json`——没有 `./list-agents`。直接解析即失败：`ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './list-agents' is not defined by "exports"`。 |
| 工具归属 | 同版本主入口的 `apply()` 里 `registerListAgents(ctx)` 与 `send_message` / `interrupt_agent` 一起注册 `list_agents`，所以删掉子路径行不丢工具。 |
| 参考行 | 宿主自带的 `dsh-web-app/presets/standard.patch.yml`（0.2.2 线）与同 profile 的 `@local/dsh-cat-preset` 的 delegation group 都只声明 `@deepseek-ai/dsh-tool-subagent-control` 主入口。 |
| 次要漂移 | 同一行把子代理选路写成 `modelSelectionSettings: true`。0.2.2 的 `Config` 只认 `modelSelection` / `modelDiscovery`；未知键**不报错、保留原样**，于是选路字段被静默关掉（`modelSelection` 落回 `false`），与「原生全能力」的承诺不符。 |

根因是 0.7.8 引入该预设时把工具行抄成了 0.2.1 线的快照，而 preset 只在**会话激活时**展开——`pnpm run check` 的 3362 项测试与 20 个 gate 里没有一个真的展开过这份组合，所以「全绿」与「会话里一行都挂不上」可以同时成立。

## Decision

- 删掉 `preset-agent-tavern-im-native` 的 `tool-subagent-list-agents` 行；`list_agents` 由 `tool-subagent-control` 主入口提供。
- `tool-subagent` 的子代理选路改为 `modelSelection: true` + `modelDiscovery: true`（与宿主 standard preset 同款）。
- 预设行上方的注释记录两个坑：宿主包只声明主入口；选路键名。
- 新增 `preset-host-rows` gate（`packages/plugin/scripts/gates/run.mjs`）：
  - 静态：patch 里任何 `@deepseek-ai/<pkg>/<sub>` 行都必须先进 `HOST_MODULE_SUBPATH_ALLOWLIST` 并写理由；裸子路径直接失败。
  - 动态：在能发现宿主安装时（`$DSH_HOST_ROOT` → profile 分布内的 `@deepseek-ai/dsh/node_modules` → profile 根 → 仓库隔离 runtime），每个声明的 `@deepseek-ai/<pkg>` 必须真的装在那；找不到任何宿主根时打印跳过原因，静态规则照跑（CI 无宿主也守得住崩溃类）。
- `im-agent-preset.spec.ts` 增加「声明宿主实际导出的行」用例：块内不出现宿主子路径、`modelSelection`/`modelDiscovery` 在场、`modelSelectionSettings` 不在场。

不做的事：不给 preset 组合补「展开即加载」的集成测试——那等于在测试里重建宿主 loader；把解析面交给 gate 的包存在性 + 子路径规则，成本低一个量级且覆盖同一失败面。

## 变更面

| 所有者 | 内容 |
|---|---|
| `packages/plugin/cordis.patch.yml` | delegation group 去掉 `tool-subagent-list-agents` 行，`modelSelectionSettings` → `modelSelection` + `modelDiscovery`，注释补踩坑记录 |
| `packages/plugin/tests/im-agent-preset.spec.ts` | 宿主行回归用例（块内子路径/键名断言） |
| `packages/plugin/scripts/gates/run.mjs` | `preset-host-rows` gate（`declaredHostModules` / `checkHostModuleSubpaths` / `checkHostModulePackages` / `hostModuleRoots`） |
| `README.md` | gate 清单与数量、测试基线 |

## 验证

- 负样本先行：把 `tool-subagent-list-agents` 行临时写回，`node packages/plugin/scripts/gates/run.mjs --only preset-host-rows` 报 `[FAIL]`，错误文案指向该行；把 `dsh-tool-pwsh` 改成不存在的包名，同一 gate 报「no discovered host installation provides」；两处还原后 `[PASS]`。
- `im-agent-preset.spec.ts` 负样本：把 `modelSelection`/`modelDiscovery` 改回 `modelSelectionSettings`，该用例失败；还原后 12 项全过。
- 声明面全解析：对 patch 里 19 个去重后的 `@deepseek-ai/*` 模块逐个用 `createRequire` 从真实 profile 根 `require.resolve`，全部命中；`Config({provider,toolName,modelSelection:true,modelDiscovery:true})` 回显两个 `true`。
- `pnpm run check`：见 README 基线（21 gates 全部 PASS）。

## 边界

- gate 的包存在性检查要求能发现宿主安装；纯 CI 环境无宿主时只跑静态子路径规则，包改名类漂移只能在本地/带宿主的环境拦住。
- 子代理选路键名仍靠 `im-agent-preset.spec.ts` 的静态断言锁定：宿主若第三次改名，gate 不会自动发现，需要跟着改这一行——但「写成未知键」不会让预设崩，风险等级不同。
- 计划模式（`planning` group）仍未纳入本预设（理由见上一决策）。
