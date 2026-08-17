# Tavern 会话使用专用 DSH 工作区

日期：2026-08-17。状态：已实施。

## Problem

客户端创建 Tavern 会话时会选择当前、最近或第一个 DSH 工作区，再调用
`connectWorkspace(workspaceId)`。因此 ST 和 AgentTavern 的宿主会话都会记入用户
正在使用的原生工作区；空白会话复用还会让 Tavern 与普通 DSH 的“新建会话”彼此
影响。隐藏原生会话树中的行只能处理显示，不能修正宿主持久化的工作区归属。

## Decision

以 `$DSH_HOME/tavern/workspace/` 子目录作为插件专用 DSH 工作区路径：

- Node half 在 `bootstrap` 中先创建子目录，再返回其绝对路径和固定显示名
  `Tavern (internal)`；子目录与角色卡、聊天记录等数据目录隔离，避免 Agent 的
  workspace-write 工具直接修改 Tavern 资产；
- client half 用 `ctx.workspaces.create({ path })` 幂等注册/复用工作区，路径而非显示名
  是身份依据；
- ST 和 AgentTavern 的新宿主会话都只调用该工作区的 `connectWorkspace`；
- client half 在原生侧边栏会话树中隐藏整个内部工作区分组。优先使用 workspace ID/路径
  识别；宿主未暴露身份属性时，仅在标题全局唯一时使用标题回退，过滤在卸载时可逆；
- 显示名重命名失败时继续使用路径命中的工作区，避免与用户已有同名工作区冲突
  阻断聊天。

## Alternatives considered

- 继续使用当前工作区并只隐藏 Tavern 会话：不能改变会话归属，也不能隔离 blank
  session 复用，否决。
- ST 和 AgentTavern 各建一个工作区：两种架构属于同一 Tavern 产品面，拆分会增加
  工作区噪声与迁移分支，否决。
- Node half 直接修改 `storages/workspace.json`：绕过宿主 API、无法触发客户端状态
  更新且会破坏存储版本边界，否决。

## Consequences

- 首次新建 Tavern 聊天时，DSH 会注册一个专用内部工作区，但插件会将其从原生侧边栏
  会话树隐藏；普通原生工作区不再新增 Tavern 会话。
- 升级前已存在的宿主会话保留原工作区归属：DSH 会话 cwd 在创建时固定，工作区
  `insertSessionBefore` 只能重排本工作区已有会话，不能跨工作区迁移。插件仍会在
  原生会话树中隐藏这些旧绑定；新建聊天立即进入专用工作区。
- 工作区注册不会删除或移动 Tavern 数据目录；用户删除该 DSH 工作区登记后，插件
  下次使用时会按同一路径重新创建。
