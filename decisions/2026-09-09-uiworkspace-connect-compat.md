# connectWorkspace 兼容 DSH 0.1.2 的 uiWorkspace 服务拆分

日期：2026-09-09。状态：已实施。

## Problem

DSH 0.1.2 把客户端 `connectWorkspace(workspaceId)` 从 `ctx.workspaces`（Workspace
Controller 的 client face，只剩 `create`/`rename`/`delete`/`archiveSession`/
`insertSessionBefore`）迁移到新服务 `ctx.uiWorkspace`。插件 client half 在新建
Tavern 聊天时仍调用 `ctx.workspaces.connectWorkspace(...)`，在 0.1.2 下抛
`connectWorkspace is not a function`，无法创建会话。

## Decision

client half 新增 `connectTavernWorkspace(ctx, workspaceId)` 兼容解析：

- 优先 `ctx.get('uiWorkspace')?.connectWorkspace`：`ctx.get` 是 client guard 的
  免声明 optional lookup，服务不存在时返回 `undefined`，rc.6 宿主安全；
- 回退 `ctx.workspaces.connectWorkspace`：覆盖 rc.6 等旧宿主；
- 不把 `uiWorkspace` 加进插件 `inject`：cordis 对声明但未提供的服务会把插件
  fiber 停在 INACTIVE（`_refresh()` 缺 impl 即 INACTIVE），在没有该服务的旧宿主
  上插件将永不激活。

门禁 `internal-workspace` 的文本标记同步改为
`connectTavernWorkspace` / `uiWorkspace.connectWorkspace` /
`ctx.workspaces.connectWorkspace` 三个断言，继续守护「Tavern 会话只经内部工作区
connect」的结构约束。

## Alternatives considered

- 只改调 `ctx.uiWorkspace.connectWorkspace` 并声明 inject：修复 0.1.2 但直接杀死
  rc.6 兼容（插件无法挂载），否决。
- 以宿主版本号分支：版本探测点多且脆，能力探测（服务是否存在）更直接，否决。

## Consequences

- 同一份 client bundle 在 0.1.2 与 rc.6 上均可新建 Tavern 会话；后续宿主若再拆分
  服务面，沿用能力探测模式扩展。
- `ctx.get` 走 guard 的 `readService(name, false)`，返回的仍是 guardedService
  代理，方法调用以真实服务为 receiver，`this.workspaces` 等内部引用不受影响。
