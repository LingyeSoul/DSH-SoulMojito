# 2026-10-21 管理面板导航重做（用户反馈「特别难用」）

## 问题

用户反馈管理面板特别难用。逐项核对 `client-src/90-panels-core.js` 注册表与
`95-ui-styles.js` 外壳样式后确认六个实锤：

1. **18 个分区平铺、零分组**：导航是一列无层级按钮，Mod 面板注册还会继续加长。
2. **图标五处重复**：`IconListPenOutline16` 同时是 指引/小说/剧本/正则/工作台，
   `IconDataOutline16` 同时是 用户人设/记忆检索，`IconBrowseOutline16` 同时是
   世界书/关于，`IconCordisPluginOutline14` 同时是 变量/Mod——扫读时无法区分。
3. **模态框固定 1080×700**：无全屏，工作台/剧本/聊天这类重分区在小盒子里内卷滚动。
4. **无搜索、无键盘导航**：找分区只能鼠标逐个扫。
5. **分区切换丢滚动位置**：`.dt-panel-body` 共享节点换内容，长清单每次切回都在顶部。
6. **移动端 700px 以下**：18 项横滑条。

## 方案

外壳层重做（不动任何分区内部业务组件）：

- **分组**：`panelSectionGroups`（content/session/system 呈现层常量）；
  18 个内置分区显式标组，overview/about 无组（置顶/置底）；动态 Mod 面板分区在
  `syncModPanelSections` 标 `group:'system'`，与 Mod 管理同组、随注册序排其后。
- **图标消重**：18 分区 18 个不同图标。全部来自宿主已验证安全集（gates 对
  synthesized 图标零容忍，新猜图标名会翻红），不足三个语义（关于/全屏展开/
  全屏收起）照 `IconGamepadOutline16` 的几何纪律自绘（16 网格、1px 描边、
  stroke=currentColor、size 协议同款）。
- **过滤框**：钉在品牌块与清单之间（与品牌同段常驻不滚），按当前 locale 显示名
  小写包含匹配；Esc 先清词；空结果显示空态文案。
- **全屏切换**：store 新增 `panelExpanded`（与 `panelSection` 同款 UI 状态语义），
  模态框挂 `dt-panel-modal-full` 吃满视口减 24px，窄屏天然回落基础规则的 min()。
- **键盘导航**：清单容器 onKeyDown，↑↓/Home/End 在可见分区间移动激活并聚焦
  对应按钮（`data-dt-section` 锚点，避开 CSS.escape 兼容面）。
- **滚动记忆**：`scrollMemory` ref 按分区 id 记 scrollTop，切回还原；组件实例
  随面板开关重建，记忆不跨打开保留（重开从顶开始，符合「打开即全貌」）。
- **移动端**：横条里过滤框与组标签退场（display:none），保持 2026-10-14 移动
  端修复形态（navlist display:contents）。

## 分页 UX（同日第二轮，用户追加「改进每个分页」）

逐页审计 18 个分区的实现后，落地一组同款模式的最小改动（清单型分区补过滤、
总览补动作面、误触保护）：

- **总览**：资产计数从一行汇总文案改为数字卡片（`.dt-stat-grid`），点击直达
  对应分区——总览的价值是「从这出发」。标签复用 `panel.section.*` 键。
- **角色/预设/剧本/正则/人设**：五个清单型分区补名称过滤框（`.dt-filter-row` +
  `panel.filterPlaceholder`），正则额外按 pattern 匹配；过滤无结果显示
  `panel.filterEmpty`。世界书条目浏览、提示词查看器原本已有搜索，未动。
- **正则**：删除从「一键即删、无回滚面」补上与角色/预设/世界书同款的
  `window.confirm` 确认（`settings.regexDeleteConfirm`）——原实现是实打实的
  误触 foot-gun。
- **预设族拆文件**：`PresetEditor` + `PanelPresets` + `BLANK_PRESET` 从
  `90-panels-core.js` 拆至 `96-panels-presets.js`（manifest 注册，函数声明提升
  跨片段可见，BLANK_PRESET 仅渲染期使用无 TDZ 风险）。原因：源文件预算
  800 行，注册表 + 角色族 + 世界书族继续增长，预设族是最干净的缝合线。
- **审计后未动的分页**：聊天侧栏（分组折叠 + 固定高度滚动已有）、指引（跟随
  绑定 + 409 冲突恢复已有）、变量（全局/本地/审计三段 + 重放已有）、Mod（本轮
  新建）、游戏（清单 + 对局面已有）、工作台/小说（自带复杂 IA，单独迭代）、
  记忆检索/提示词/关于（设置面/只读查看器/静态信息，无清单可过滤）。

## 否决项

- **指令面板（Ctrl+K palette）**：过滤框已覆盖「找不到分区」的核心痛点，
  palette 多一层命令抽象，YAGNI。
- **可拖拽调整模态框尺寸**：宿主 Modal 不承载 resize 语义，全屏切换已覆盖
  「空间不够」的主场景。
- **给 18 个分区各配宿主新图标**：宿主图标清单 0.2.0-rc.2 起改描边后缀命名，
  猜名字必踩 gates synthesized 红线；自绘是更便宜且已证伪不了的路径。
- **分区内部内容重做**（工作台/小说等 18 个面板各自的信息架构）：超出本次
  「外壳导航难用」的边界，单独立项。

## 与规格的偏差

- `tavern-panel-layout.spec.ts` 第一个结构锁原样锁定「inline
  `panelSections.map(...)` 直接产按钮」；分组后按钮改由命名 `sectionCell` 经
  三个挂点（topUngrouped/组内/bottomUngrouped）渲染进清单，spec 按新契约
  重锁（含负样本），gates frontend-runtime markers 同步追加。
- `games-client.spec.ts` 的游戏分区 marker 因注册项插入 group 字段按新源序
  重锁。
- 既有 CSS witness（`.dt-panel-nav`/`.dt-panel-navlist`/`.dt-panel-header`/
  移动端整行）逐字保留，未动。
- client-src 片段清单新增 `96-panels-presets.js`（预设族拆分，见上）；拼接
  顺序不影响语义（同一 ModuleLoader 工厂作用域，函数声明提升）。

## 兼容

- 宿主图标零新增请求（自绘 3 个 + 已验证安全集 15 个），gates 形状对账不受影响。
- `panelExpanded` 缺省 false，旧宿主/旧状态文件无该字段时行为同今。
- Mod 动态分区未标组时落入无组后置位（about 之后）——本次已在注册点显式标组，
  但 registerPanelSection 是公开追加口，第三方调用方不标组仍可用（兜底成立）。
