# 提案 0003：Tavern 管理面板（侧栏 footer 按钮 + shell.overlay 全面板）

> 状态：已实现并验证（tsc + 17 文件 135 项测试 + 六道 gate 全绿；施工计划见
> `docs/plans/2026-08-15-tavern-panel-implementation.md`，决策记录见
> `decisions/2026-08-15-tavern-management-panel.md`）。日期：2026-08-15。基线：提案 0002 已交付的六面能力。
> 宿主事实来源：`@deepseek-ai/*` rc.6 编译产物的 slot catalog
> （`dsh-cordis-client-runner/lib/client.js` `CLIENT_SLOT_API`）与
> `dsh-client-ui-primitives`/`dsh-client-ui-theme` 类型声明，2026-08-15 调研核实。

## 0. Working Backwards（用户视角的 PR）

DSH 侧边栏底部、紧挨 Settings 按钮的位置，常驻一个 Tavern 按钮（宽栏显示
图标+文字，56px rail 仅图标）。点击打开一个与原生 Settings 同构的模态面板
（1080x700 上限、左侧图标导航 + 右侧内容区、模糊遮罩、Escape 关闭），集中
管理全部 Tavern 资产：角色卡（含完整卡查看）、聊天与分支、群组、persona、
世界书（含条目浏览器）、预设、regex、脚本变量、Kobold Text Completion 与
管线模式。视觉全部走 DSH 设计 token 与官方 UI 原语，与原生界面不可区分。

## 1. 问题与结论

当前 UI 两个痛点：

1. **管理面挤在 Settings 里**。`settings.section` 一个 section 承载了导入、
   persona CRUD、群组管理、regex、管线、Kobold 六块管理功能，纵向无限堆叠，
   没有 DataTable/网格空间，卡片级浏览（角色、世界书条目）放不下。
2. **侧栏管理需要与宿主会话树并存**。最初方案误把 `useSidebarHost` 视为应退役的 hack，导致角色/聊天快速切换入口被删。事实是宿主没有可承载 Tavern 会话树的专用 slot；`useSidebarHost` 是当前兼容层，必须保留。需要退役的只是旧的独立浮动 fallback（`dt-floating-shell`），不是侧栏聊天树。

| 需求 | 官方扩展点 | 证据 |
|---|---|---|
| 侧栏按钮（像 Settings） | `sidebar.footer.action`（list, root scope）——语义即"Settings 旁边的可选动作"，官方占用者 CordisPanel（ui-cordis）在此 | `dsh-client-ui-sidebar/lib/client.js` L207-216：footArea = `renderSlot("sidebar.footer.action", {wide})` + `renderSlot("sidebar.settings", {wide})` |
| 大面板容器 | `shell.overlay`（list, root scope）——frame 级浮层，"above every column and outside their scroll containers"；层 pointer-events:none，entry 自行 opt-in | `dsh-client-ui-layout/lib/client.js` L234-238；root slot 文档明确引导自造全屏 surface 走此路 |
| Dialog 原语 | `Modal({open, onClose, title, children, footer, headless})`——居中卡片 + 模糊遮罩 + Escape + aria-modal | `dsh-client-ui-primitives/lib/types/Modal.d.ts` L19-30；`dsh-client-web/lib/index.js` PLATFORM_MODULES 白名单内，client bundle 可直接 require |

不复用的方案及否决理由：

- **接管 `sidebar.settings`（single slot）**：会顶掉真正的 Settings 按钮，破坏宿主。
- **`ctx.commandUi` 斜杠命令**：`CommandUiSpec.kind` 现阶段仅 `'popupSelect'`，
  挂不了任意 React 面板（`dsh-client-ui-commands/lib/types/client/contract.d.ts` L31-35）。
- **继续制造独立浮动 shell**：不再保留旧的 `dt-floating-shell` fallback；面板统一走 `shell.overlay` + `Modal`，但侧栏会话树仍由 `useSidebarHost` 兼容层注入并保留。

## 2. 入口按钮（`sidebar.footer.action`）

现有 `SidebarFooterAction` 从"侧栏挂载失败的回落开关"转正为**常驻主入口**，与保留的 Tavern 侧栏聊天树并列：

- 点击行为：打开管理面板（`dsh-tavern:toggle-panel` window 事件 + store 状态，
  对齐现有 `toggle-sidebar` 模式），不再 toggle 浮动 shell。
- wide 形态直接对齐原生 Settings trigger：`width:calc(100% + 8px)`、34px 高、
  14px 字体/22px 行高、12px 圆角与相同 margin/padding；rail 形态同为 36px
  圆形图标按钮（18px 图标），`aria-label` + Tooltip。
- 图标：`IconSparkle16`（角色扮演语义，与宿主既有图标不撞车）；
  label 走 locale thunk（`nav.title`，中英已有）。
- 同 slot 多占用者（CordisPanel 等）天然共存，list slot 按 order 排列。

## 3. 面板容器（`shell.overlay` + `Modal`）

在现有 `shell.overlay` entry 中由 PanelHost 同时承载侧栏会话树 portal、bindings/prune 与面板 Modal：

```
Modal(headless, open, onClose)          ← 原语：遮罩/Escape/aria-modal/焦点
└─ div.dt-panel[role=dialog 结构自绘]   ← 复刻 Settings 同款两栏
   ├─ nav（左，约 200px）
   │   ├─ Brand 行（IconSparkle16 + "Tavern" + 版本戳）
   │   └─ navCell 按钮 ×N（icon + label，激活态高亮，aria-current）
   └─ content（右，flex-1）
       ├─ header（分区标题 + 分区级动作 + Close）
       └─ body（滚动区，分区内容）
```

- 尺寸：`min(1080px, calc(100vw - 48px)) × min(700px, calc(100vh - 64px))`，
  对齐 Settings 设计稿（figma 501:29947, 1080x700）。
- 响应式：≤700px 时 nav 折叠为顶部横向滚动条（复用现 settings 媒体查询思路）。
- 动效：开合用 `--ds-transition-duration-slow` + `--ds-ease-in-out`。
- 实现验证：Modal 会 portal 到 `document.body`，不受 `shell.overlay` 的
  `pointer-events:none` 影响。宿主 dialog 默认 `padding-bottom:24px` 且背景为
  `--dsw-alias-bg-layer-2`，会露出底部异色带；`.dt-panel-modal` 明确覆盖
  `padding:0; gap:0; background:var(--dsw-alias-bg-base)`，由 `.dt-panel` 填满卡片。

## 4. 信息架构（左 nav 分区 → 能力矩阵）

| 分区 | 现状（迁移源） | 面板新增能力 |
|---|---|---|
| 总览 | 设置页"Active setup" | 活跃配置卡片（角色/预设/persona/世界书多选）+ 版本/commit 戳 + 快速切换 + 各资产计数 |
| 角色 | 设置页 select + 导入 | 卡片网格（头像/名字/creator/卡规格 Pill）；**完整卡查看器**（description/personality/scenario/firstMes/example dialogues，`MarkdownText` 渲染，`DisclosureRow` 折叠）；设为活跃；**删除**（RiskConfirmation）；**导出 PNG** |
| 聊天 | 侧栏 Tavern 会话树（保留） | 同一 TavernSidebar/ChatList 在侧栏与面板双处复用；按角色/群组分组（⑂ 分支标记 + 回链），新建/重命名/删除/打开到会话（`openTavernChat` 复用） |
| 群组 | 设置页管理带 | 成员 chips（启停/移除）、激活策略、allow_self_responses、群组头像（回落首成员，复用 avatar 路由） |
| Persona | 设置页管理带 | CRUD、PNG 导入、头像、position/depth 编辑 |
| 世界书 | 设置页 checkbox 列表 | 世界卡片（条目数 Pill + 激活开关）；**条目浏览器**（keys/content/深度/顺序，搜索过滤，`Input` + 虚拟滚动可后置）；**删除** |
| 预设 | 设置页 select + 导入 | 列表 + kind Pill（chat-completion/context/instruct/sampler）；设为活跃；**删除** |
| Regex | 设置页列表 | 启停、删除、placement 标签迁移 |
| 变量 | 无 UI | **全新**：全局 `scriptGlobals` 查看/编辑；聊天局部变量按当前绑定聊天查看 |
| 生成 | 设置页管线 + Kobold 带 | 管线模式切换、Kobold 端点/API key/流式/模板选择、`StateDot` 连接状态 + 测试连接 |

## 5. UI 复用清单（DSH 原语 → 用途）

| 原语（`@deepseek-ai/dsh-client-ui-primitives`） | 面板用途 |
|---|---|
| `Modal`（headless） | 面板容器（遮罩/Escape/aria-modal/焦点管理） |
| `Button`（primary/ghost/outline/toolbar） | 导入、新建、删除、nav/头部动作 |
| `Input` | 名称、端点、API key、搜索框 |
| `Menu`/`MenuItem` | 下拉选择（预设/persona/激活策略；宿主无 Select 组件，官方模式即 Menu） |
| `Tooltip` | rail 图标按钮、图标动作 |
| `Toast` | 导入成功/失败、删除完成 |
| `DisclosureRow` | 卡片字段折叠（规格详情、条目内容） |
| `MarkdownText` | 卡描述、firstMes、世界书条目内容 |
| `StateDot` | Kobold 连接状态 |
| `RiskConfirmation` | 删除角色/世界书/群组确认门 |
| `Pill` | 预设 kind、卡规格（V2/V3/PNG/charx）、分支标记 |
| 图标 ×70（`IconSparkle16`/`IconTrashOutline16`/`IconDownloadOutline16`…） | nav、动作、状态 |

Token 层全部取自 `dsh-client-ui-theme/design-platform.css`：
`--dsw-alias-bg-base/bg-layer-1/bg-overlay/bg-mask-*/border-l1..l4/brand-primary/
label-primary|secondary|tertiary/button-*/interactive-bg-hover(-danger)/
state-error|success|warn-*`、`--dsw-shadow-lv3`、`--dsw-specific-menu`（浮层底），
运动用 `--ds-transition-duration-slow`/`--ds-ease-in-out`。现有 `dt-*` 样式里
已验证的同名变量引用直接沿用，不新造颜色。

## 6. 服务端增补（薄路由；store 方法均已存在）

| 路由 | 实现 | 备注 |
|---|---|---|
| `GET character/<name>` | `db.getCharacter` → `publicCard` | 卡查看器 |
| `DELETE character?name=` | `db.deleteCharacter` + 清 activeCharacter/相关 sessionBindings + `refreshActivePrompt()` | 需要清绑定与活跃提示，防止悬挂引用 |
| `GET world/<name>` | `db.getWorld` → WorldBookIR | 条目浏览器 |
| `DELETE world?name=` | `db.deleteWorld` + 从 activeWorlds 移除 | |
| `DELETE preset?name=` | `db.deletePreset` + 清 activePreset | |
| `GET export/character/<name>` | `db.exportCharacter` → PNG 字节 | 导出按钮 |
| `GET variables` / `PUT variables` | `state.scriptGlobals` 读写 | 变量分区 |

`REQUIRED_SERVER_ROUTES` gates 同步扩面（对齐提案 0002 第 6 节纪律）。

## 7. 旧表面处置

- **`settings.section` 瘦身保留**：仅"Active setup"快速切换（角色/预设/
  persona/世界书四个选择器）+ "打开 Tavern 面板"按钮（共享面板 open state）。
  重管理全部移入面板。肌肉记忆不破坏，设置页不再无限纵向堆叠。
- **侧栏聊天树保留，与面板共存**：保留 `useSidebarHost`（MutationObserver + 几何
  启发式）和 `[data-dsh-tavern-sidebar-host]` 注入，维持角色/聊天的日常快速选择；
  同一 TavernSidebar/ChatList 也在面板"聊天"分区复用。只删除旧的
  `dt-floating-shell`、`dsh-tavern:toggle-sidebar` 与 `sidebarAttached` fallback 状态。
- **不动**：`conversation.view` / `conversation.composer` /
  `conversation.session.header.actions` / locale 注册 / API 面。

## 8. 里程碑与验证

- **M1** 服务端路由增补 + gates 扩面 + vitest（含删除级联：activeCharacter/
  activeWorlds/activePreset/sessionBindings 清理路径）。
- **M2** 面板骨架：footer 按钮两形态（wide/rail）+ shell.overlay Modal 容器 +
  nav/content 框架 + 总览分区；SidebarFooterAction 转正。
- **M3** 迁移：角色/群组/persona/regex/生成五分区从设置页搬入（行为等价，
  locale 键复用）；settings.section 同步瘦身。
- **M4** 新能力：卡查看器、世界书条目浏览器、变量、导出、删除闭环；
  侧栏聊天树与面板聊天分区共存（同一 TavernSidebar/ChatList 复用），仅退役独立浮动 fallback。

验证：`pnpm check`（tsc + vitest + build + gates）全绿；浏览器冒烟清单——
footer 按钮 wide/rail 两形态、面板开合/Escape/遮罩点击、九分区渲染、
导入→查看→删除闭环、删除活跃角色后活跃提示清空、Kobold 测试连接 StateDot、
≤700px 布局折叠、中英 locale 切换。README 能力面表更新。

## 9. Bar Raiser 评审记录（自攻击）

1. **shell.overlay + Modal 叠层**：Modal 自身遮罩与 overlay 层的
   pointer-events 交互是最大集成风险，M2 首项验证；失败则退化为自绘
   `div.overlay > div.mask + div.panel[role=dialog]`（Settings 同构 DOM，
   该结构在 `dsh-client-ui-settings-general/lib/client.js` L113-169 有权威参照）。
2. **删除级联**：删角色必须同步清 activeCharacter、绑定该角色的
   sessionBindings、群组 members 引用（群组成员被删时 putGroup 收敛），
   M1 测试覆盖。
3. **可发现性**：rail 模式下图标按钮无文字，靠 Tooltip + aria-label；
   设置页瘦身区保留入口按钮兜底。
4. **不做的事**：卡编辑器（写路径）不在本提案——查看器先行，编辑留提案 0004；
   条目浏览器虚拟滚动（世界书 >500 条目）后置；不接管 `sidebar.settings`。
