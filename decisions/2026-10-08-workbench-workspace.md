# 写卡工作台使用专用内部 DSH 工作区

日期：2026-10-08。状态：已实施。

## Problem

写卡工作台会话此前与角色扮演会话共用 `Tavern (internal)` 工作区，且客户端
全局只复用一个工作台会话。卡片工作台的排错场景以聊天为粒度引用角色与楼层
（提案 0013 §2），每个聊天对应一个写卡工作会话后，工作台会话会随聊天数量
增长，与 ST/AgentTavern/Novel 会话混在同一工作区互相污染；全局单会话也使
多个聊天的排错上下文互相覆盖。

## Decision

- 以 `$DSH_HOME/tavern/workbench/` 作为写卡工作台专用 DSH 工作区路径，显示名
  `Tavern Workbench (internal)`；bootstrap 以 `workbenchWorkspace` 字段下发，
  注册核（路径为身份、显示名 rename 失败不阻断）与 `Tavern (internal)` 共用；
- `sessionBindings` 的 `card-workbench` 变体增加 `sourceCharacter`/
  `sourceChatId` 来源聊天身份（agent-novel 的 `novelId` 先例）：聊天行「交给
  工作台」按身份幂等复用或新建工作会话，面板拉起的自由工作台两者为空串；
- `workbench-open` 桥命令携带来源身份；已绑定会话拒绝换绑其他来源（在
  preset marker 幂等检查之前 fail-closed，防止绑定被静默改写）；
- 原生侧边栏会话树对两个插件内部工作区整组隐藏；自绘 TavernSidebar 增加
  「写卡工作台」分组列出全部工作台会话（来源聊天命名 + 自由工作台），并提供
  自由工作台入口。
- 出卡后会话改名（同日补充）：card_create 成功后，绑定记 `createdCard`
  （侧边栏分组标签改为卡名，最新出卡胜出；workbench-open 幂等重写保留该
  字段），宿主标题经 agent 作用域 ctx 运行时探测 `sessionTitle` 服务后
  `rename(活会话, 卡名)` 固定（对齐 deduce.ts 的 subagents 探测模式，不 inject
  声明）。两路 best-effort、失败不阻断出卡；非 card-workbench 绑定的会话
  不受影响。

## Alternatives considered

- 继续共用 `Tavern (internal)` 且维持全局单会话：多聊天排错上下文互相覆盖，
  会话列表无法按来源导航，否决。
- 在 2026-08-17 决策的「同一 Tavern 产品面不拆工作区」基础上继续合并：该决策
  针对的是 ST 与 AgentTavern 两种角色扮演架构；写卡工作台是不同的产品面
  （创作/维护 vs 游玩），且会话数量模型不同（每聊天一个），拆分不违背其划分
  逻辑。
- 按来源聊天拆成多个工作区（每聊天一个）：工作区噪声随聊天数线性增长，且
  宿主工作区没有生命周期管理，否决。

## Consequences

- 新工作台会话进入 `Tavern Workbench (internal)`；升级前已存在的旧工作台
  绑定会话留在原工作区（DSH 会话 cwd 创建时固定），侧边栏分组按绑定列出、
  不依赖工作区归属，旧会话仍可正常复用。
- 旧绑定数据无 `sourceCharacter`/`sourceChatId` 字段时在读取边界归一化为
  空串，等价于自由工作台身份，无需迁移。
- 原生树隐藏逻辑从单一工作区匹配泛化为插件工作区集合匹配，后续新增内部
  工作区只需扩展 `pluginWorkspaceSnapshots` 的配置列表。
