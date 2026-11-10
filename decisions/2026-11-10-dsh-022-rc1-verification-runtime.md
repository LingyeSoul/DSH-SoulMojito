# DSH 验证 runtime 升级到 0.2.2-rc.1（宿主 API seam 审计）

> 日期：2026-11-10。状态：已实施。相关：`decisions/2026-10-18-dsh-021-rc2-compat.md`（上一轮宿主深度适配）、`decisions/2026-11-09-agent-ptc-mode.md`（PTC 的两条宿主线）。

## 用户需求

「更新本仓库的验证用的 DSH 到最新版本。」

## Problem

仓库验证依赖隔离 runtime `.npm-cache/dsh-runtime`，它镜像 `0.2.1-rc.5`；npm `latest` 已到 `0.2.2-rc.1`（全局 `dsh --version` 同为该版）。验证宿主落后意味着 `pnpm run check` 没有在真实最新宿主上跑过，README 的版本口径、工具面与 client 兼容证据都会漂移。

## Decision

- 按原布局重建隔离 runtime：取 `@deepseek-ai/dsh@0.2.2-rc.1` tarball 解包为 runtime 根（保留 dsh 自身 `package.json` 与 `lib/bin.js`），在根内执行 `npm install --include=dev`，得到 677 个安装包、342 个 `@deepseek-ai/*` 包（旧 runtime 为 305 个）。
- 不新增安装脚本或缓存层；`.npm-cache/` 仍被 gitignore，仓库只提交版本口径与验证证据。
- 兼容口径改为「面向最新、旧版本宿主随缘」：本轮只提升验证宿主，旧宿主不再作为承诺面回归。

## 宿主 API 审计（0.2.1-rc.5 → 0.2.2-rc.1）

| 面 | 变化 | 对本仓库 |
|---|---|---|
| `dsh-tools` | `ToolRuntime` 的工具呈现管线重构为 `ToolsService` + `ToolExecutor`；0.2.1 的 `presentAs` / `modeFor` / `sdkSection` / `collapseSection` 移除；新增 `setExecutor` / `definitions`，并按 scope 用 `scoped` WeakMap + `selectExecutor` 选择 executor | PTC 的 0.2.2 executor 线已存在（`packages/bind/src/ptc.ts`），无需改代码；0.2.1 presentation 线保留给旧宿主，单测用桩覆盖 |
| `dsh-tool-executor-ptc` | 成为随宿主安装的一等包（`0.2.2-rc.1`） | `importHostPackage` 预检与 `ctx.plugin(module)` 直接命中 |
| `dsh-session` | store-owned Session 在 `announce` 完成前只读；`enter` / `announce` 语义收紧 | 写入准入测试对真实宿主代码回归通过，无适配 |
| `dsh-subagent` | `activation` 增加 `omitClosingText` | `startActivation` 路径未变 |
| `dsh-client-ui-workspace` | 新增 `whenAccess`，`connectWorkspace` 签名未变 | client 探针无需改 |
| `dsh-api-session-controller` | 内部 manager / lineage 调整 | 公开 `ISessions` 契约未变 |
| `dsh-agent-preset` | 类型面无 diff | 不变 |

## 验证

重建 runtime 后执行完整 `pnpm run check`（2026-11-10，Windows，Node 24.22.1）：

```
Test Files  203 passed (203)
Tests       3362 passed | 2 skipped (3364)
20 gates    全部 PASS
built       v0.7.8 (8739174)
```

- runtime 自检：`node .npm-cache/dsh-runtime/lib/bin.js --version` → `0.2.2-rc.1`。
- 复跑说明：一次默认并发的 vitest 命中 V8 `Committing semi space failed`（环境内存耗尽，无断言失败）；`--maxWorkers=2` 重跑同一测试面全绿。build 与 20 gates 随后单独执行，全部通过。
- 2 项跳过仍是环境条件（Windows 上的 POSIX-only `host-package` 用例、Win32 无 0600 mode）。
- 20 个 gates 全 PASS，其中 `client-vm-mount` 继续从 `dsh-web-frontend` 产物解析 UI 原子表，`v4-session-admission` 直接跑新宿主的会话准入实现。
- README 顶部版本、测试基线、runtime 镜像版本同步更新。

## 边界

- 本轮没有改插件代码：最新宿主下既有 seam 全绿，不为版本号制造改动。
- 旧宿主（含 `0.2.0-rc.2`）改为随缘：`packages/bind` 的旧形状分支与对应单测仍在，但不再作为发布承诺或本轮回归面。
- 旧 runtime 备份只用于升级过程回滚，验证通过后删除，避免两份缓存被误用。
