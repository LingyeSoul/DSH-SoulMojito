# 会话打开面的 uiWorkspace 兼容（修复 ctx.sessions.open is not a function）

日期：2026-09-30。状态：已实施。

## Problem

插件 client half 的 `openTavernChat` / `openNovelSession` 共 4 处调用
`ctx.sessions.open(sessionId)`（源 `client/main.js`，随构建拼接进产物
`client/index.js`）。DSH `0.2.0-rc.2` 的 sessions 服务（`ClientSessions`，
`dsh-api-session-controller`）公共面上**没有 `open`**——只剩
`retain` / `using` / `create` / `fork` / `binding` / `list` / `retainInfo` 等。
「把会话打开到主视图」被挪进 `UiWorkspaceService.openSession`
（`dsh-client-ui-workspace`，内部 `replaceMain`：retain `source=mainView` +
替换 selection + 释放旧引用；主视图当前会话由 `retainedBy.mainView > 0`
派生）。结果：在 0.2.0-rc.2 宿主上打开任意 Tavern 聊天或 Novel 会话时抛
`TypeError: ctx.sessions.open is not a function`。

这批调用是仓库初建（适配 0.1.x 宿主）时引入的遗留；`6ffa75c` / `992d321`
适配 0.2.0-rc.2 时改了 UI primitives 命名与 `connectWorkspace` 服务面，
但未覆盖这批调用点。

## Decision

与 `connectHostWorkspace` 的双面探测同构，`@dsh-tavern/bind` 的 client 探测
模块新增 `openHostSession(ctx, sessionId, trace)`：

- 首选 `ctx.get?.('uiWorkspace')?.openSession`（0.1.2+ / 0.2.0 服务面）；
  与 connectWorkspace 一样保持 declaration-free——`exports.inject` 声明
  `uiWorkspace` 会让插件在没有该服务的 rc.6 宿主上永远挂起；
- 回退 `typeof ctx.sessions?.open === 'function'`（旧宿主面，函数存在性
  守卫保证新宿主不会踩到）；
- 都没有时抛带语义的错误并在轨迹记 `unavailable`；
- 命中路径与调用次数写入 `ClientShapeTrace`（`openSessionPath` /
  `openSessionCalls`），随 `window.__DSH_TAVERN_BIND__` 供诊断读取。

client half 增加 `openSessionView(ctx, sessionId)` 薄封装并替换 4 处调用；
产物由 `scripts/build-plugin.mjs` 重新生成。

## Alternatives considered

- 直接改成 `ctx.sessions.retain(id, { source: 'mainView' })`：retain 只建立
  mainView 保留，不替换 workspace 控制器的 selection/panel，与原生
  `openSession` 行为不等价（且旧 mainView 保留不会被释放），否决。
- 在 `exports.inject` 里声明 `uiWorkspace`：rc.6 宿主无此服务，声明注入会让
  插件挂起（host-probe 既有结论），否决。

## Consequences

- 同一份 client bundle 在旧命名与新命名宿主上均可打开会话；会话打开路径
  与 workspace 连接路径共用同一套 bind 探测/轨迹模式。
- `client-probe.spec.ts` 新增 `openHostSession` 6 个用例（首选面、回退面、
  unavailable、无 open 方法的 sessions 面、无 trace 调用、轨迹初值）。
- 后续宿主再挪「打开会话」的服务面，只改 `host-probe.ts` 的探测顺序。
