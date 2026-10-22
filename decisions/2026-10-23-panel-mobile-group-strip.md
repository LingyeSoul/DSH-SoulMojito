# 管理面板移动端标题区挤压：分组容器在 700px 断点里的退场

> 日期：2026-10-23。用户实况：「改进管理面板在移动端上的显示，现在的版本会导致
> 分页标题区挤在一起」。RCA 证实：2026-10-21 导航重做新增的 `.dt-panel-group`
> 列向容器没有被 700px 断点的移动端分支覆盖，18 个分区在横条里竖排成
> content / session / system 三列，分区标题挤在一起，主区高度被压掉两百多像素。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/client-src/95-ui-styles.js`（移动端媒体查询：分组容器退场 + 横条盒模型/overscroll）、`packages/plugin/client-src/94-panels-tail.js`（`navRef` + 活动分区 chip 入视）；测试 `packages/plugin/tests/tavern-panel-layout.spec.ts`；门禁 `packages/plugin/scripts/gates/run.mjs` 的 `frontend-runtime` marker 表（含负样本自证） |
| 唯一事实来源 | 用户问题的那一行 + 700px 断点既有契约（移动端面板 = 品牌图标 + 横向可滑分区按钮条 + 全宽主区）+ 2026-10-21 分组注册表（`panelSectionGroups` / 各项 `group`） |
| 持久态 | 无（纯 CSS 规则 + 组件内 effect，不落盘、不进 state.json） |
| 临时态 | 无新增。活动 chip 入视只改 DOM `scrollLeft`，不写 store；面板重开从完整清单与首屏位置开始 |
| 外部依赖 | 无新增。复现/验收用 headless Chromium（agent-browser 0.31.1，CDP）加载插件真实注入 CSS（从 `client/main.js` 的 `installStyle()` 模板逐字节抽出）+ 真实面板 DOM；宿主 Modal 尺寸按 `.dt-panel-modal` 的 `min()` 规则模拟（390×844 视口 → 面板 342×700） |
| 注册入口 | 无新增/删除 |
| 删除路径 | 删媒体查询里的 `.dt-panel-group{display:contents}` 即回到本次挤压形态（spec 与门禁双双翻红）；删 `navRef` / reveal effect 只失去「程序化切区把活动 chip 滚进可视区」，不恢复挤压；回退 `box-sizing` / `overscroll-behavior-x` 只回到既有的右缘裁切与边缘手势冒泡 |
| 兼容对象 | 桌面（>700px）几何零变化（量测对账）；移动端回到 2026-10-14 的横条形态；Mod 追加分区仍标 `system` 组并随横条排布；旧宿主/旧 state 无新字段依赖 |

## RCA：为什么标题区又挤在一起

2026-10-14 的移动端回归是「`.dt-panel-navlist` 列向容器漏进横条」，当时的
修法是移动端 `display:contents`。2026-10-21 导航重做为分组清单，在
`.dt-panel-navlist` 内部新增了每组的 `.dt-panel-group`（桌面规则
`display:flex;flex-direction:column;gap:2px;margin-top:6px`），媒体查询只补了
`display:none` 的组标签（`.dt-panel-group-label`），**没有让新的组容器退场**。

于是移动端横条（行向 flex）里：

1. `.dt-panel-navlist` 已 `display:contents`，18 个分区按钮不再被它包住；
2. 但按钮仍被三个 `.dt-panel-group` 包住，组容器保持列向 flex、`flex:1` 不再
   生效（display:contents 后不再参与 nav 的 flex 布局，组容器成为横条的 flex
   子项）；
3. 三个组在横条里并排成三列，每列内部竖排 6/4/7 个按钮 → 横条高度取最高列
   （system 组 250px），分区标题看起来就是「挤在一起」的三摞；
4. `.dt-panel` 是列向 flex、nav 是 `flex:none`，横条高度直接吃掉主区。

**量测证据**（headless Chromium、CDP 设备模拟 390×844、面板 342×700、真实
插件 CSS + 真实 DOM、18 个内置分区）：

| 状态 | nav | 三个组容器 | 主区 | 正文 |
|---|---|---|---|---|
| 修改前 | 358×**277** | 92×214 / 66×142 / 92×250（列向） | 342×**423** | 342×**354** |
| 修改后 | 342×**55** | 0×0（`display:contents`） | 342×**645** | 342×**576** |

同一形态在 360×740 与 700×800 复现/复核：

| 视口 | 状态 | nav | 主区 | 正文 |
|---|---|---|---|---|
| 360×740 | 前 | 328×277 | 312×399 | 312×330 |
| 360×740 | 后 | 312×55 | 312×621 | 312×552 |
| 700×800 | 前 | 668×277 | 652×423 | 652×354 |
| 700×800 | 后 | 652×55 | 652×645 | 652×576 |

桌面断点外侧 `701×800`：nav 215×700（列向）、主区 438×700，与 2026-10-14
量测一致；`1280×800`：nav 215×700、navlist 589/771 独占滚动、组容器保持
列向 flex——桌面契约未被本次改动触碰。

## 落法

- **组容器退场**：移动端媒体查询加 `.dt-panel-group{display:contents}`，与
  `.dt-panel-navlist{display:contents}` 同款理由——横条的语义是「条里只有
  按钮」，清单层与分组层都不应生成盒。组标签原本已 `display:none`，组内按钮
  回到横条 flex 流，横条的 `overflow-x:auto` 直接承接整条清单的滑动。
- **横条例式盒模型**：同一条规则补 `box-sizing:border-box`。2026-10-14 的
  决策已留档：横条基础规则 `width:100%` + padding 在 content-box 下会比容器宽
  16px，右缘被 `.dt-panel{overflow:hidden}` 裁掉；本次顺手收掉这个已知瑕疵
  （移动端 358 → 342 的宽度差即来自这里）。
- **横向手势不冒泡**：补 `overscroll-behavior-x:contain`，横条滑到头时不会触发
  浏览器/宿主的前进后退手势。
- **活动 chip 入视**：`navRef` + `useEffect([section, state.panelOpen])` 在移动端
  把当前分区按钮居中滚进横条。2026-10-14 决策把「横条不自动把活动分区滚到
  可见」列为已知边界；总览数字卡片、会话头「打开游戏/小说面板」等程序化切区
  会绕过横条点击，活动标题停在屏外时用户无法确认当前页。桌面 nav 无横向溢出，
  `scrollWidth <= clientWidth` 的 guard 让 effect 成为 no-op；滚到首尾时由
  `Math.max(0, …)` 与浏览器上限自然夹取。

## 验证

- **真实浏览器量测**（agent-browser 0.31.1 + Chromium，插件真实注入 CSS 从
  `client/main.js` 逐字节抽取；宿主 Modal 尺寸按 `.dt-panel-modal` 规则模拟）：
  - 390×844：nav 55（scrollW 1482 / clientW 342）、主区 645、正文 576；组容器
    全部 `display:contents`（0×0）。
  - 360×740：nav 55、主区 621、正文 552。
  - 700×800（断点内侧）：nav 652×55、主区 645；701×800（断点外侧）：nav
    215×700 列向、主区 438；1280×800：navlist 589/771 独占滚动、桌面导航不变。
  - 活动 chip：390×844 下 `section='prompts'`，目标偏移 1196 被上限夹到 1140，
    chip 落在横条 211–290（可视区 24–366）——末尾分区也可见。
- **测试**：`tavern-panel-layout.spec.ts` 13 项全过。移动端用例锁新的
  `.dt-panel-nav` 整行（含 `box-sizing` / `overscroll-behavior-x`）、
  `.dt-panel-group{display:contents}`、并补「横条里不得再现组容器列向规则」的
  回归断言；新增「活动 chip 入视」用例锁 `navRef`、effect guard 与滚动算式；
  负样本面补 `display:contentsX`、`navRef` 近邻 miss、`Math.max(1, left)`。
- **门禁**：`frontend-runtime` 增 3 条 marker（组容器退场、`navRef`、chip 入视
  算式），每条配负样本自证；18 个 gate 全 PASS。
- **构建**：`node scripts/build-plugin.mjs` 刷新 `client/main.js` /
  `client/index.js`；`tsc -b` 零错。
- **本机全量 vitest 偏差如实留档**：`pnpm run check` 的 vitest 段被一处与本改动
  零交集的断言挡下——`packages/tavern-store/tests/store.spec.ts` 的
  「状态：默认值 → patch 持久化」期望里还没有 `disabledAutoWorlds`，而工作区
  内另有一份未提交的 store 默认值改动包含该字段。本改动只碰 `client-src/94`、
  `client-src/95`、对应 spec/gates 与构建产物，不引用 `tavern-store`；该失败
  按工作区并行改动处理，未改其断言。

## 边界（如实标注）

- **只锁结构与规则文本**：jsdom 无布局引擎，组容器是否真的生成盒、横条是否
  真的 55px、chip 是否真的入视，靠本文记录的 headless Chromium 量测；CI 由
  spec 的规则文本断言 + gates marker（含负样本）对账——与 2026-10-14 / 10-21
  的既有边界一致。
- **横条仍会随分区数增长**：19 个内置分区 + Mod 动态分区的 scrollW 已 1482px；
  「分组标签在横条里退场」意味着移动端只保留顺序语义，不显示组名。移动端导航
  的信息架构（分组分隔、下拉选择、分组折叠）仍是独立议题，本修不做。
- **chip 入视是居中而非贴边**：首尾分区无法真正居中，落在可视区边缘；不做
  平滑滚动动画，避免打开面板时扫过整条清单。
- **横条过滤框在移动端仍隐藏**：分区搜索是桌面导航的能力，移动端用横滑 +
  入视定位；把过滤框放进横条会再次占用标题区高度，本修不做。