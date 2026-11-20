# DSH 验证 runtime 升级到 0.2.2-rc.5（宿主 API seam 审计）

> 日期：2026-11-20。状态：已实施。相关：`decisions/2026-11-10-dsh-022-rc1-verification-runtime.md`（上一轮宿主升级）、`decisions/2026-10-18-dsh-021-rc2-compat.md`（bind 全 seam 审计）。

## 用户需求

「把验证用的 DSH 更新的最新版本，然后检测兼容性。」

## Problem

仓库验证依赖隔离 runtime `.npm-cache/dsh-runtime`，它镜像 `0.2.2-rc.1`；npm `latest`/`next` 均为 `0.2.2-rc.5`。验证宿主落后意味着 `pnpm run check` 没有在真实最新宿主上跑过，README 的版本口径与宿主兼容证据都会漂移。

## Decision

- 按原布局重建隔离 runtime：取 `@deepseek-ai/dsh@0.2.2-rc.5` tarball 解包为 runtime 根（保留 dsh 自身 `package.json` 与 `lib/bin.js`），在根内执行 `npm install --include=dev --no-audit --no-fund`，得到 695 个安装包、350 个 `@deepseek-ai/*` 包（旧 runtime 为 677 / 342）。
- 不新增安装脚本或缓存层；`.npm-cache/` 仍被 gitignore，仓库只提交版本口径、验证证据与决策记录。
- 兼容口径保持「面向最新、旧版本宿主随缘」：本轮只提升验证宿主，旧宿主不再作为承诺面回归。
- 本轮未改插件源码：全量 check 在 `0.2.2-rc.5` 上全绿。

## 宿主 API 审计（0.2.2-rc.1 → 0.2.2-rc.5）

| 面 | 变化 | 对本仓库 |
|---|---|---|
| `dsh-session` | 新增批量 `append(inputs: readonly SessionEventInput[])`；单事件 `append(type, data, opts)` 重载保留；新增 `currentBatchPublication` / `prepareBatch` | 插件仍走单事件重载；批量面由 `@dsh-tavern/bind` 的 `appendSessionEvents` 采用（见 `2026-11-20-batch-session-append.md`） |
| `dsh-tools` | `ToolGuard` 返回值放宽为 `string \| ToolGuardDenial`；新增 `ToolContextUnavailableError` | 插件 guard 仍返回 `string \| undefined`，向上兼容 |
| `dsh-tool-executor-ptc` | 配置新增 `maxSubCallsPerMinute`；executor 探测面 `setExecutor` / `selectExecutor` / `definitions` / `scoped` 未变 | `packages/bind/src/ptc.ts` 的能力探测与挂载路径不变 |
| `dsh-subagent` | `Activation` 内部字段重构（`pool` / `parent` / `ancestry` / `ownedChildren` / `observer` → `runId` / `provider` / `root` / `ancestors` / `path` / `accepted`）；公开 `startActivation(spec)` 的 `provider` / `label` / `request` / `signal` / `delivery` 形状未变 | `spawnSubagent()` 的两代 API 特性检测继续命中 |
| `dsh-system-prompt` | 分区常量调整（移除 `TEAM_IDENTITY`，新增 `TOOL_PTY_PANEL`） | 插件只依赖 `complete` 与插值语义，不引用常量 |
| `dsh-api-session-controller` | `hasApiSessionSubagentOwner` 去掉 ctx/agent 参数 | 插件未调用该内部函数；公开 `ISessions` 契约未变 |
| `dsh-client-ui-workspace` | 新增 `WorkspacePickerInput` 与 archive-notice 事件 | `connectWorkspace` / `openSession` 探测面未变 |
| `dsh-agent-preset` | 类型面无 diff | 不变 |
| `dsh-client-ui-primitives` | 仍不投递到 runtime `node_modules` | `client-vm-mount` 继续从 `dsh-web-frontend` 产物解析原子表，PASS |

## 验证

2026-11-20，Windows，Node 24.22.1。重建 runtime 后执行完整 `pnpm run check`：

```
node .npm-cache/dsh-runtime/lib/bin.js --version
0.2.2-rc.5

Test Files  218 passed (218)
Tests       3540 passed | 2 skipped (3542)
21 gates    全部 PASS
built       v0.8.1 (9ca0709)
```

- `pnpm run check` 依次通过 `tsc -b`、安全与插件两份 typecheck、vitest 全量、`build:plugin` 与 21 个 gates。
- 2 项跳过仍是环境条件（Windows 上的 POSIX-only `host-package` 用例、Win32 无 0600 mode）。
- `client-vm-mount`、`v4-session-admission`、`node-half-mount` 等直接读取新宿主产物的 gates 全绿。
- README 顶部版本、测试基线、runtime 镜像版本同步更新。批量 append 跟进后的最终基线为 220 files / 3560 passed / 2 skipped（见 `decisions/2026-11-20-batch-session-append.md`）。

## 附带修复（与本轮宿主升级无关，但阻塞了验证）

`packages/tavern-store/tests/state-slices.spec.ts` 把 `withStore(...)` 的 Promise 直接传给 `it()`；Vitest 将非函数第二参当作 options，14 个用例因此实际空跑，断言失败只以 unhandled rejection 出现。修成 `it('...', () => withStore(...))` 后用例真正执行，并暴露 `PRE_SPLIT_DEFAULT_STATE_KEYS` 缺少 `cardWorkbenchNativeAgentMode`（`b574e19` 新增默认键时漏更新）。两处均已修复，14/14 通过。

## 边界

- 旧 runtime 备份在验证通过后删除，避免两份缓存被误用。
- 本轮不改插件源码版本号；`0.8.1` 基线不变。