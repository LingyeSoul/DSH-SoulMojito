# 管理面板导航列「标题区固定」+ 游戏图标手柄化：面板外壳的两处实况修订

> 日期：2026-10-14。用户实况两则：①（截图红框）管理面板左上「Tavern + 版本号」
> 品牌块要固定不动，只有其余部分滚动；②「游戏的图标换成游戏相关的如手柄图标」。
> 两条都落在面板外壳（导航列 + 分区图标）上，一并处理。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/client/main.js`（`TavernPanel` 的 nav 结构 + `.dt-panel-*` 规则 + 新增 `IconGamepadOutline16`）；测试 `packages/plugin/tests/tavern-panel-layout.spec.ts`（新增）、`games-client.spec.ts`（图标面）；门禁 `scripts/gates/run.mjs` 的 `frontend-runtime` marker 表 |
| 唯一事实来源 | 用户问题的那一行：品牌块固定 = `.dt-panel-nav` 不再自滚、清单独占滚动；游戏图标 = 四处游戏面共用同一组件 |
| 持久态 | 无（纯前端渲染结构，不落盘、不进 state.json） |
| 临时态 | 无 |
| 外部依赖 | 无新增。宿主 primitives 沿用既有 30 个解析名（手柄图标是本地自绘，不进 bind 解析面） |
| 注册入口 | 无新增 slot/service；面板分区注册表（提案 0015 §3.5）与右栏 tab guide 的 `icon` 字段取值变化 |
| 删除路径 | 还原 `.dt-panel-nav{…overflow-y:auto}` 并删 `.dt-panel-navlist` 封装即回旧行为（会回归本反馈）；图标改回 `IconSparkle16` 即回旧图标（`games-client.spec` 计数锁会翻红提醒） |
| 兼容对象 | 面板 Modal 的宿主 DOM 未变（仍走宿主 `Modal` + `headless`）；Mod 追加分区（`registerPanelSection`）行为不变，只是被追加进滚动清单；旧宿主（无 sidebarRight 服务）回落路径不变 |

## RCA：滚动的是哪一块（证据坐标）

用户的描述是「标题区域固定不动」，但面板里有两个候选：主区标题栏（分区名 + 关闭）
和左列品牌块。**先量再改**，不猜：

1. **复现环境**：headless Chrome + 宿主真实 `Modal.module.css`（
   `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2` 的 `.root/.dialog`）+ 本插件真实
   注入 CSS（从 `installStyle()` 的模板字面量逐字节取出）+ 真实 DOM
   （`.root > .dialog.dt-panel-modal > .dt-panel > nav + main`）。
2. **主区标题栏本来就没问题**：`.dt-panel-header` 早已在 `.dt-panel-body` 之外，
   `body.scrollTop=1806` 时 header 的 `getBoundingClientRect().top` 恒定（32→32）。
   用户红框指的不是它。
3. **真正被卷走的是左列品牌块**：`.dt-panel-nav` 原规则
   `…border-right:1px solid var(--dsw-alias-border-l2);overflow-y:auto`——滚动容器是整条
   nav，品牌块（`.dt-panel-brand`）是它的第一个子元素。量测：nav `clientHeight 698 /
   scrollHeight 789`（18 个分区就溢出），滚动它则品牌块随之上移出可视区；用户截图
   里被红框圈住的正是这块，且截图右侧可见整列滚动条。
4. **为什么现在才暴露**：分区数在涨——内置 13 个（提案 0015 §3.5 P0）之后陆续加了
   Mod 管理、游戏、记忆检索、提示词、关于，且 `registerPanelSection` 允许 Mod 继续
   追加；700px 高的 Modal 装不下第 17 个分区之后，滚整列就成了必经路径。

## 落法

- **nav 拆两段**：`nav.dt-panel-nav`（`overflow:hidden`，只做竖排容器）内放
  `div.dt-panel-brand`（常驻）与 `div.dt-panel-navlist`（`flex:1;min-height:0;
  overflow-y:auto`，分区按钮全在这里）。结构上品牌块在 navlist 之前闭合——
  `tavern-panel-layout.spec.ts` 用括号配平扫过这两条闭合关系。
- **主区显式化**：`.dt-panel-header` 补 `flex:none`（列方向 flex 里默认 `flex-shrink:1`，
  内容极端时标题栏会被压；虽然 `.dt-panel-body` 有 `min-height:0` 兜底，标题栏的
  「不参与伸缩」应当由自己的规则表达）。
- **手柄图标自绘**（`IconGamepadOutline16`，定义在游戏桥代码段）：
  - 宿主 0.2.0-rc.2 的图标清单**全量核对过没有手柄类图形**——最接近的
    `IconPlayOutline*` 是「播放」、`IconGoalOutline*` 是「目标」，都不是游戏语义；
  - 也不能借不存在的宿主名：bind 层对宿主没有的 `Icon*` 名会记进
    `synthesized` 并降级为空渲染，`client-vm-mount` 门禁会因此直接拦下产物；
  - 几何按宿主图标的纪律自绘：16 网格 viewBox、`fill:none`、`stroke:currentColor`、
    1px 描边（`IconXxx16` 经 bind 别名解析进的 Regular 档观感）、`size` 属性同款；
  - 形态按 **16px 真光栅**选：7 个候选（胶囊 rx3.5 / 胶囊 rx3 / 带握把机型 /
    Lucide gamepad-2 等比缩编 / 填充圆点版 / 1.3px 描边版 / 圆环按钮版）各自
    SVG→canvas 1:1 光栅后 10x 最近邻放大目检——带握把的机型在 16px 糊成一团
    （机翼细节喂给了亚像素），最终取「胶囊机身 + 十字键 + 两颗填充按钮」，三个特征
    在小尺寸下都立得住。
- **四处游戏面同款**：面板分区注册表 `{ id: 'games', icon: IconGamepadOutline16 }`、
  右栏 tab guide 的 `icon`、AgentTavern 标题栏入口按钮、右栏空态卡（`size: 22`）。
  「总览」继续用 `IconSparkle16`（两个分区不再共用图标——游戏图标的意义就是不与
  总览混）；`games-client.spec.ts` 用计数锁（1 处定义 + 4 处使用 = 5）钉住，
  将来新增游戏面漏换图标会翻红。

## 验证

- **真实浏览器量测（headless Chrome，同上复现环境）**：
  - 改后 `nav.overflowY === 'hidden'`、nav 自身 `scrollHeight === clientHeight`（不再自滚）；
  - 清单 `scrollHeight 646 / clientHeight 629`，`scrollTop` 从 0 推到 17 时品牌块
    `top` 恒定（57→57）；
  - 主区 `body.scrollTop` 推到 1456 时 header `top` 恒定，分区标题仍是 `总览`；
  - 整面板截图目检：品牌块常驻，清单滚动条收进清单区（8px 内缩，不再贯穿整列）。
- **门禁**：`frontend-runtime` 新增 5 条 marker（图标组件在场 / navlist 结构 /
  nav 不自滚规则 / 清单独占滚动规则 / header `flex:none` 规则），每条配一个负样本
  自证有牙（图标改名、清单容器去掉、三条 CSS 规则各自回退分别翻红）。
- **测试**：新增 `tavern-panel-layout.spec.ts`（4 项：品牌块在清单外且两者闭合关系、
  nav 不自滚 / 清单独占滚动、标题栏不伸缩 + 内容区独占滚动、近邻负样本）；
  `games-client.spec.ts` 增手柄图标面（计数锁 + 四处 marker + 总览仍 sparkle + 近邻负样本）。
- **端到端**：`pnpm run check` exit 0——tsc 零错、97 文件 1422 过 +1 跳、15 gates 全 PASS、
  dist 六件随构建刷新。

## 边界（如实标注）

- **品牌块占的 50px 是不可滚的**：700px 高的 Modal 下，清单可视区少了一档。分区数
  继续增长（Mod 追加）到 19+ 时会更挤——届时的正确动作是清单分组/紧凑行高/搜索，
  本修不动行高，也不引入溢出提示。
- **只锁结构，不锁像素**：仓库没有浏览器布局测试基建（jsdom 无布局引擎，量不出
  「谁在滚」），所以 CI 锁的是结构与规则文本，真实滚动行为靠本次的 headless Chrome
  量测记录在案（本文）。若日后要机械守住，需要把 headless 浏览器纳入 CI 依赖。
- **手柄图标是本地自绘**：拿不到宿主图标集迭代的红利。若宿主某天导出 gamepad 类
  图标，正确动作是迁回宿主名（bind 别名会处理尺寸后缀），而不是留着自绘不动。
- **滚动条位置变化**：原来 nav 的滚动条贯穿整列（含品牌块），现在只在清单区且
  因 nav 的 8px 内边距而内缩——这是「品牌块固定」的必然副作用，不是回归。
- **`IconGamepadOutline16` 不进 bind 解析面**：它不是宿主 primitives 的请求名，
  因此不参与 `client-vm-mount` 的形状轨迹比对；它若被误删，翻红的是
  `frontend-runtime` 的图标 marker 与 `games-client.spec` 的计数锁，不是形状轨迹。
