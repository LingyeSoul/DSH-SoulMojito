# 写卡工作台内部工作区在每条入口都要能创建

日期：2026-10-24。状态：已实施。承接 [`2026-10-08-workbench-workspace.md`](2026-10-08-workbench-workspace.md)、[`2026-08-17-internal-tavern-workspace.md`](2026-08-17-internal-tavern-workspace.md)。

## Problem

用户反馈「写卡工作台似乎不会创建内部对应工作区」。按路径登记的
`Tavern Workbench (internal)` 只在**新建工作台会话**时注册，已有工作台会话
的打开路径从不经过注册核；缓存的 workspace 视图又被当作存在性依据。

## RCA

1. **入口覆盖不全**：`openWorkbenchSession` 的幂等复用分支（聊天侧「交给
   工作台」）与侧栏 `WorkbenchList` 行点击都只 `openSessionView`。宿主工作区
   登记被删/被宿主 registry 重建、或会话创建于专用工作区之前（
   2026-10-08-workbench-workspace 的升级后果）时，这两条路径永远不会重建
   内部工作区。
2. **缓存未复核**：`ensureWorkbenchWorkspace` 在 `workbenchWorkspace.path`
   命中时直接返回缓存视图。宿主的 workspace 登记一旦消失，`connectWorkspace`
   会以 `unknown workspace` 拒绝，插件也不会按同一路径重建——违背
   2026-08-17 决策 §Consequences「用户删除该 DSH 工作区登记后，插件下次使用时
   会按同一路径重新创建」。
3. **冷启动假失败**：`apply` 的 bootstrap 是 fire-and-forget，侧栏「+」可在
   `bootstrap.workbenchWorkspace` 到达前被点击，直接抛
   `error.noWorkspace`（「没有可用于酒馆会话的 DSH 工作区」）。

## Decision

- `pluginWorkspaceRegistered(ctx, workspace)`：复用缓存前先核对宿主
  `ctx.workspaces.list` 是否仍含该 `workspaceId`；旧宿主没有 list 面时保持
  rc.6 的缓存语义。缓存失效即按同一路径重新 `create`（宿主按 canonical path
  幂等，重建的 workspace 会把 cwd 匹配的旧会话重新归组）。
- `pluginWorkspaceConfig(kind)`：workspace 字段缺席时补等一次
  `refreshBootstrap()` 再判定，消除冷启动误报。
- `openWorkbenchSessionView(ctx, sessionId)`：打开既有工作台会话的统一入口
  （侧栏列表行 + 聊天侧复用分支），best-effort 调 `ensureWorkbenchWorkspace`
  后打开，失败绝不阻断导航。

## Alternatives considered

- **apply 时预创建两个内部工作区**：给从不使用工作台/酒馆会话的用户也塞两个
  隐藏工作区登记，否决。
- **Node half 直接写 `storages/workspace.json`**：绕过宿主 API 且破坏客户端
  状态同步，与 2026-08-17 否决项一致，否决。
- **完全去掉客户端缓存**：每次打开会话都多一次 `create` 往返；保留缓存 +
  复核已能覆盖登记消失，去掉缓存是过度代价，否决。

## Consequences

- 登记正常时行为不变：缓存命中即返回，新增的是一次 list 快照读取。
- 登记缺失时，下一次打开任一工作台会话（含列表行）都会重建
  `Tavern Workbench (internal)`；旧会话按 cwd 回到该分组。
- 冷启动点击「+」不再误报 `error.noWorkspace`，最多多等一次 bootstrap。