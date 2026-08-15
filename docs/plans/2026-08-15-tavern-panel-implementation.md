# 施工计划：Tavern 管理面板（提案 0003 落地）

> 日期：2026-08-15。设计来源：`docs/proposals/0003-tavern-management-panel.md`（已冻结）。
> 验证基线：`pnpm check` = tsc -b + vitest + build-plugin + 六道 gate 全绿。

## 任务分解

### M1 服务端（`packages/plugin/src/index.ts` + `packages/tavern-store`）

| # | 改动 | 文件 | 细节 |
|---|---|---|---|
| 1.1 | `GET character/<name>` | src/index.ts | `db.getCharacter` → `publicCard`，404 语义对齐 avatar 路由 |
| 1.2 | `DELETE character?name=` | src/index.ts | `db.deleteCharacter`；级联：清 activeCharacter（命中时）、prune 该角色的 sessionBindings、从各群组 members/disabledMembers 收敛（putGroup）、`refreshActivePrompt()` |
| 1.3 | store.deleteCharacter 扩展 | tavern-store/src/store.ts | 同时 `fs.rm(chats/<name>, {recursive, force})`（对齐 ST 删角色连聊天） |
| 1.4 | store 测试 | tavern-store/tests/store.spec.ts | 建角色+聊天 → deleteCharacter → 聊天目录消失 |
| 1.5 | `GET world/<name>` | src/index.ts | `db.getWorld` → WorldBookIR（条目浏览器数据源） |
| 1.6 | `DELETE world?name=` | src/index.ts | `db.deleteWorld` + 从 activeWorlds 移除 |
| 1.7 | `DELETE preset?name=` | src/index.ts | `db.deletePreset` + 清 activePreset（命中时）+ 清 textCompletion 三处模板引用（命中时） |
| 1.8 | `GET export/character/<name>` | src/index.ts | `db.exportCharacter` 字节流，content-type 按 found.kind（png/zip/json），attachment disposition |
| 1.9 | `GET/PUT variables` | src/index.ts | `state.scriptGlobals` 读写；PUT 校验键值类型（string/number/boolean） |
| 1.10 | gates 路由扩面 | plugin/scripts/gates/run.mjs | REQUIRED_SERVER_ROUTES += `character/`、`world/`、`variables`、`export/character/` |

### M2 面板骨架（`packages/plugin/client/index.js`）

| # | 改动 | 细节 |
|---|---|---|
| 2.1 | require 面扩充 | 从 `dsh-client-ui-primitives` 增补 `Modal`、`Button`、`Input`、`StateDot`、`Pill`、`Tooltip`、`IconSparkle16`、`IconDownloadOutline16`、`IconSearchOutline16`（props 已对 d.ts 核实） |
| 2.2 | 面板状态 | snapshot += `panelOpen/panelSection`；`openPanel(section)/closePanel()`；window 事件 `dsh-tavern:toggle-panel` |
| 2.3 | `PanelHost` | 接替 SidebarAdapter 注册 `shell.overlay`（id `dsh-tavern-panel`）；承接 bindings/prune 副作用；渲染 `Modal(headless)` + `TavernPanel` |
| 2.4 | `TavernPanel` | 左 nav（PANEL_SECTIONS：overview/characters/chats/groups/personas/worlds/presets/regex/variables/generation）+ 右 content（header+body）；尺寸 `min(1080px,…)/min(700px,…)`；`pointer-events:auto` |
| 2.5 | `SidebarFooterAction` 转正 | 常驻 `sidebar.footer.action`（id 改 `dsh-tavern-panel`），点击 `openPanel()`；逐项对齐 Settings trigger：wide=34px 高/14px 字体/22px 行高，rail=36px 圆钮/18px 图标 + Tooltip |
| 2.6 | 上下文持有者 | `SidebarAdapter.context` → 模块级 `runtimeContext`（apply() 赋值）；MessageRow.branch / TavernView 回链改引用 |

### M3 分区迁移 + settings 瘦身（client/index.js）

| # | 改动 | 细节 |
|---|---|---|
| 3.1 | PersonaBand → PanelPersonas | 逻辑原样迁移（dt-band 样式沿用） |
| 3.2 | GroupBand → PanelGroups | 同上 |
| 3.3 | RegexBand → PanelRegex | 同上 |
| 3.4 | PipelineBand → PanelGeneration | 迁移 + 测试连接结果旁加 `StateDot`（done/error） |
| 3.5 | TavernSettings 瘦身 | 保留：标题/版本 + Active setup（4 选择器 + nativePersona）+ 世界书开关 + "打开 Tavern 面板" `Button(primary)`；移除四带与导入带 |

### M4 新能力 + 侧栏共存（client/index.js）

| # | 改动 | 细节 |
|---|---|---|
| 4.1 | PanelOverview | 活跃配置卡 + 资产计数 + 版本戳 |
| 4.2 | PanelCharacters | 卡片网格 + 导入 + 完整卡查看器（GET character/，MarkdownText 渲染字段，DisclosureRow 式折叠）+ 设为活跃 + 删除（confirm）+ 导出（a[download]→export 路由） |
| 4.3 | ChatBrowser → PanelChats | TavernSidebar/ChatList 主体同时复用于宿主侧栏与管理面板聊天分区；侧栏负责日常快速切换，面板负责集中管理；新建/重命名/删除/打开 |
| 4.4 | PanelWorlds | 激活 checkbox + 条目浏览器（GET world/，搜索 Input 过滤 keys/content）+ 导入 + 删除 |
| 4.5 | PanelPresets | 列表 + kind Pill + 设为活跃 + 删除 + 导入 |
| 4.6 | PanelVariables | 全局变量编辑（GET/PUT variables；数值串自动转 number）+ 当前会话绑定聊天的局部变量只读展示 |
| 4.7 | 侧栏与面板共存 | 保留 `useSidebarHost`/`visibleSidebarTree`/`[data-dsh-tavern-sidebar-host]`，让 TavernSidebar 继续注入宿主侧栏；移除旧的独立 `dt-floating-shell`/`toggle-sidebar` 事件/`sidebarAttached` 标志；同一 ChatList 逻辑在面板聊天分区复用 |
| 4.8 | locale | 新键 zh/en 成对增补（gates 强校验键齐性 + {param} 一致） |
| 4.9 | gates 期望更新 | requiredSlots：`shell.overlay` id → `dsh-tavern-panel`；`sidebar.footer.action` id → `dsh-tavern-panel` |

### M5 收尾

| # | 改动 |
|---|---|
| 5.1 | `pnpm check` 全绿（tsc/vitest/build/gates），失败项修复闭环 |
| 5.2 | README 能力面 + UI 说明更新 |
| 5.3 | proposal 0003 状态 → 已实现并验证；新增 `decisions/2026-08-15-tavern-management-panel.md`（记录：入口选型、Modal×overlay 叠层结论、删角色连聊天、变量数值收敛、侧栏聊天树与管理面板共存） |

## 风险与预案

1. **Modal×shell.overlay 叠层**（提案 Bar Raiser #1）：Modal 返回 portal，mask/card 自带 fixed 层级；shell.overlay 层 pointer-events:none 但子元素可重新 opt-in——`.dt-panel-modal{pointer-events:auto}` 双保险。若真机异常，退化为自绘 `div.overlay>div.mask+div.panel[role=dialog]`（宿主 settings-general 同构）。
2. **gates VM 桩**：React 桩不支持并发特征/引用细化——新组件只用现有 hooks（useState/useEffect/useRef/useId/useSyncExternalStore），不引新依赖。
3. **locale 齐性**：每个新键 zh/en 同步提交，{param} 名单一致；写完跑 gates 即时暴露。
4. **client 不进 tsc**：client/index.js 是手维护 bundle（不在 tsconfig 覆盖内），类型错误只能靠 gates VM 执行 + 真机冒烟——改动保持小步、风格与现文件一致（`h()` createElement 模式）。

## 交付顺序

M1 → M2 → M3 → M4 → M5，每步后跑对应验证（M1: vitest+gates；M2-M4: build+gates；M5: 全量 check）。
