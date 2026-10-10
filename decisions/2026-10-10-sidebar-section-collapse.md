# 侧边栏酒馆/写卡工作台分区可折叠

日期：2026-10-10。状态：已实施。关联：`decisions/2026-10-09-workbench-session-rename.md`（写卡工作台侧边栏分区的既有行内能力）。

## Problem

侧边栏（`TavernSidebar`）注入在宿主会话树上方，纵向空间与原生树共享。角色/分组
多时「酒馆」分区把「写卡工作台」子标题及其会话列表推到视口外，两块内容都无法
让位；用户没有整体收起某一分区的手段（角色条目自身可折叠，但分区标题行不可）。

## Decision

- **分区标题行即折叠钮**：「酒馆」主标题与「写卡工作台」子标题从静态 span 改为
  `dt-sidebar-heading-toggle` 按钮，chevron 用 `IconChevronDownOutline14` +
  `dt-chevron-open` 旋转惯例（与 `dt-character-toggle` 同款：展开朝下、收起朝右），
  带 `aria-expanded`。折叠只藏内容、标题行常驻；工作台标题右侧的「新建自由
  写卡工作台」+ 按钮折叠时仍可用。
- **折叠态进客户端 store 而非组件 state**：`sidebarCollapsed: { tavern, workbench }`
  挂进 `useTavernStore` 快照（`panelSection` 同款 UI 状态语义）。docked 侧栏门户
  与管理面板聊天分区两个 `TavernSidebar` 挂载点共享同一份折叠态，一处折叠两处
  同步；页面重载随 store 回默认全展开（现有 `panelSection` 亦不跨重载，不引入
  localStorage 先例）。
- **「酒馆」折叠整块收起**：角色列表、「暂无角色」空态、「分组」子标题与分组
  列表都在门控内；折叠不影响 `expanded`/`expandedGroup` 组件状态，重新展开恢复
  原有展开层级。
- **CSS 收口**：`.dt-sidebar-heading>button{width:26px}` 的图标钮规则对折叠钮
  不适用（需占满标题行），以 `.dt-sidebar-heading>button.dt-sidebar-heading-toggle`
  更高特异性覆盖为 `width:auto; flex:1`；chevron 旋转圈在 `.dt-sidebar-chevron`
  span 内，避免把标题里的用户图标 svg 一起旋转。

## Alternatives considered

- **组件内 useState**：改动最小，但 docked 门户与面板聊天分区两实例各自持态，
  一处折叠另一处仍展开。否决，store 只多一个字段即换来双挂载点一致。
- **localStorage 持久化**：跨重载记忆折叠态，但客户端至今无 localStorage 先例，
  且「省空间」是会话内临时诉求（重载后默认全展开不误导新会话）。否决，留待真
  实诉求出现再议。
- **「分组」子标题独立折叠**：分组列表天然受「酒馆」整块折叠覆盖；单独再给一个
  折叠钮增加噪音而省不了更多空间（分组条目自身已有 chevron）。否决。

## Consequences

- 两分区可独立收起，侧边栏最小占位缩到两行标题（含「+」钮仍可新建工作台）。
- store 快照新增 `sidebarCollapsed` 字段；老版本服务端/新客户端无耦合（纯客户端
  UI 状态，无路由与协议改动）。视觉三态（全展/酒馆折叠/全折叠）经静态 harness
  以真实 installStyle CSS 截图核验。
