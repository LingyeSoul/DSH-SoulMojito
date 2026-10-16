# SoulMojito 品牌 logo 落四面：面板标题区 + 侧栏按钮 + 设置页入口 + 面板「关于」分区（2026-10-16）

> 日期：2026-10-16，同日两轮。第一轮需求：「为 DSH-SoulMojito 设计 svg 图标，并在
> 管理面板的标题区域使用，然后把侧边栏的酒馆按钮换成图标和 SoulMojito」——形态由用户
> 在候选表上改选为「U 形高脚杯插薄荷叶配一个斜放的吸管」，落地为本地自绘
> `IconSoulMojito16`（面板品牌块 / 侧栏按钮 / 设置页入口三处）。
> 第二轮（本文件描述的当前态）：用户交付正式 logo 并追加需求——「图标换成这个，并在
> Readme 中添加，关于页也显示图标和 DSH-SoulMojito」。第一轮的本地自绘 mark 被正式
> logo 整体替换，落点从三处扩到四处，README 顶部与「关于」分区头部同时带上品牌面。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `assets/logo.svg`（用户交付的正式 logo，设计源）；`packages/plugin/client/main.js`（内联组件 `SoulMojitoLogo` + 四处引用 + `.dt-about-head` 规则）；测试 `packages/plugin/tests/tavern-panel-layout.spec.ts`（品牌 case + asset↔内联对账 case）；门禁 `scripts/gates/run.mjs` 的 `frontend-runtime` marker 表；`README.md` 顶部图与「Tavern 管理面板」段品牌句 |
| 唯一事实来源 | 用户交付的 `assets/logo.svg`（viewBox、几何、配色） + 本轮需求原话 |
| 持久态 | 无（纯前端渲染，不落盘、不进 state.json） |
| 临时态 | 无 |
| 外部依赖 | 无新增；logo 本地交付，不新增宿主 primitives 解析名（不进 bind 解析面） |
| 注册入口 | 无新增 slot/service；`sidebar.footer.action` 的注册未动，只改渲出的内容 |
| 删除路径 | 四处 `h(SoulMojitoLogo…)` 换回 `h(IconSparkle16…)`、关于分区标题换回 `'dsh-soulmojito'`、README 删顶部 `<img>` 与品牌句即回旧观感；品牌 case 的计数锁与 asset 对账 case 会翻红提醒 |
| 兼容对象 | `nav.title` 未动：侧栏分区标题、宿主 conversation tab 标签、原生会话树过滤（`titles = [MESSAGES_EN/zh['nav.title']]`）全部照旧；面板 Modal 的宿主 DOM、Mod 追加分区（`registerPanelSection`）、旧宿主回落路径均不变 |

## 为什么内联而不是运行时读文件

client half 是宿主 ModuleLoader 的 IIFE，没有取文件的通路；`assets/logo.svg` 是仓库级
设计源（README 展示 + 对账基准），应用内以 `SoulMojitoLogo` 组件内联同一份几何与配色。
两处重复由 `tavern-panel-layout.spec.ts` 的 asset↔内联对账 case 钉住：asset 里所有
`d`/`fill`/`stroke`/`stroke-width`/`fill-opacity`/`transform` 字面量与 `viewBox` 逐条要求
出现在 `main.js`（字面量数 ≥ 15 的断言防止 asset 改写风格后这条 case 空跑通过）。换 logo
只改一边必翻红。

## 几何与落法

- **viewBox 原样保留**（`-90 -100 180 190`）。headless Chrome 实测内容外框（含 2.5
  描边）：x −60.5…60.5、y −100.05…60.5 → 121×160.55，即内容占 67% 宽 / 84.5% 高；薄荷叶
  顶点 y≈−100.05 恰好贴住 viewBox 上沿（越界 0.05，可忽略）。原样入库是刻意的：这是用户
  的设计资产，不收框改版。
- **全彩、不走 `currentColor`**：这是 logo 不是图标。面板品牌块的
  `.dt-panel-brand>svg{color:var(--dsw-alias-brand-primary)}` 只设 `color`，路径自带 fill
  不受影响；深/浅底都靠酒液与描边的绿色对比立住，不做主题自适应（logo 常规做法）。
- **方形 `size` 下的 letterbox**：viewBox 是竖幅（180×190），方形盒里高度绑定——玻璃实高
  约 84% 盒高、宽约 64%，两侧与下方留白。
- **四处落点与尺寸**：
  1. 面板品牌块 `.dt-panel-brand`：`size` 16，直接作为 flex 子项（沿用既有
     `.dt-panel-brand>svg{flex:none}`）。
  2. 侧栏 footer 按钮 `SidebarFooterAction`：`size: wide ? 16 : 18`；可见文字仍是
     `'SoulMojito'`，rail 折叠态仍是纯图标钮。
  3. 设置页面板入口（`.dt-settings-heading` 右侧 `Button`）：只换 `icon`，按钮文字仍是
     `t('panel.open')`。
  4. 面板「关于」分区头部（本轮新增）：`size` 40。

## 「关于」分区头部

原先是 `h('h3', null, 'dsh-soulmojito')`——渲染的是目录名而非品牌名。本轮改为
`.dt-about-head` 一行：40px logo + `h('h3', null, 'DSH-SoulMojito')` + 版本 stamp
（stamp 与面板品牌块同源 `bootstrap.version/commit`），官网/作者/源码仓库三行外链不动。
新增 CSS：`.dt-about-head{display:flex;align-items:center;gap:12px;margin-bottom:12px}`、
`.dt-about-head>svg{flex:none}`、`.dt-about-head-copy{display:flex;flex-direction:column;min-width:0}`、
`.dt-about-head-copy h3{margin:0}`（末条抵消 `.dt-settings-band h3{margin:0 0 14px}`，否则
标题与 stamp 之间会被撑开 14px）。品牌名用字面量、不进 i18n（品牌名中英同形，对齐第一轮
判定）。

## README

顶部居中加 logo：`<p align="center"><img src="assets/logo.svg" alt="DSH-SoulMojito logo" width="112"></p>`
（相对路径仓库内资源，GitHub 经 camo 渲染 SVG）。「Tavern 管理面板」段的品牌句改为指向
`assets/logo.svg` + 四处落点。README 只展示，不做第二份几何。

## 验证

- **真实光栅目检**：headless Chrome 把交付 SVG 渲染成 16/18/20/24/32/48px，浅底 + 深底
  各一组，并叠加四处落点近似（关于分区头部 40px + 品牌块 + footer 宽栏/rail）；
  16px 下冰块与气泡被亚像素吃掉，但玻璃轮廓 + 绿色酒液 + 薄荷叶三特征仍分得开。
  另用 `getBBox` 实测内容外框，确认叶尖只越界 0.05 且 `transform` 列表按 `T·R` 生效
  （手算曾误判为越界 2.9，实测否定了这个判断）。
- **门禁**：`frontend-runtime` 品牌 marker 从 3 条扩到 5 条（组件名 / `viewBox` 帧 /
  品牌块主名 / footer 可见品牌名 / 关于标题），每条配一个负样本自证有牙（组件改名、
  viewBox 改一位、主名回退 `Tavern`、footer 文字回退、关于标题回退非品牌写法分别翻红）。
  marker 全 ASCII。
- **测试**：`tavern-panel-layout.spec.ts` 品牌 case 计数锁改为 1 定义 + 4 引用 = 5，新增
  设置页入口 `icon` 断言、关于分区头部三条断言与「小写目录名标题不得再现」反向断言；
  新增 asset↔内联对账 case；近邻负样本扩到 10 条（含资产几何改 1 单位）。
- **端到端**：`pnpm run check` exit 0——tsc 零错、104 文件 1692 过 + 1 跳、15 gates
  全 PASS、产物（`client/index.js` 等）随构建刷新。

## 边界（如实标注）

- **16px 仍是绑定约束**：宽栏 footer 与品牌块有文字陪衬，rail 折叠态只有图标。交付 logo
  在 16px 靠「玻璃轮廓 + 绿色酒液 + 薄荷叶」三个方面立住；冰块气泡在该尺寸不可见，是
  缩放必然，不是缺陷。
- **框未收**：内容只占 viewBox 的 67%×84.5%，方形盒里玻璃实高约 84% 盒高。若后续要把
  16px 版面吃满，正确动作是把 viewBox 收到内容外框（约 `-63 -102 126 164`，实高可提到
  ~98%），代价是 `assets/logo.svg` 与内联组件两处必须同步重框——asset 对账 case 会拦住
  只改一边。本次不动用户交付的帧。
- **只锁结构与文本，不锁像素**：仓库没有浏览器布局测试基建（jsdom 无布局引擎），16px
  观感靠本次 headless 截图记录在案（本文）；CI 机械守住的是 marker、计数锁与源文本断言。
- **品牌资产不再随宿主图标集走**：logo 是用户交付的设计资产，与宿主 `Icon*` 集解耦；
  第一轮那条「宿主若导出酒杯类图标就迁回宿主名」的备选路径随之作废（宿主图标集里不可能
  有这枚品牌 logo）。
- **面板名未改**：面板标题仍是「酒馆管理面板」、footer 按钮的 `title` 仍是
  `t('panel.title')`、`aria-label` 动作部分仍是「打开酒馆面板」（可见文字改动带出的
  label-in-name 修正在第一轮已落：`${t('panel.open')} · SoulMojito`）。
- **提案 0003 不改**：`docs/proposals/0003-tavern-management-panel.md` 里
  「图标：`IconSparkle16`」仍是设计当时的取值——该提案自称「九个分区」，而面板已涨到
  18 个分区，它本就作为设计快照存在，不逐行维护。当前状态的事实来源是 README 与本文。
- **不升版**：本次是标识与外观层修订，非特性增量——对齐改名轮
  （`decisions/2026-10-16-project-rename-dsh-soulmojito.md`）的不升版判定；示例 Mod 的
  `engines ^0.6.5` 不受影响。
