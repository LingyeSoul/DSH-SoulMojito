# 管理面板移动端横向按钮条回归：导航清单容器在 700px 断点里的退场

> 日期：2026-10-14。用户实况：「在移动端上，管理面板的各个页的按钮占据了整个面板，
> 几乎看不到页面对应内容」，并直接点名因果：「这个问题是上一次固定标题栏引起的」。
> RCA 证实该判断：回归由 6613a75（导航列「标题区固定」）引入——新增的
> `.dt-panel-navlist` 桌面滚动容器没有被 700px 断点的移动端分支覆盖。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/client/main.js`（`.dt-panel` 移动端媒体查询，唯一改动点）；测试 `packages/plugin/tests/tavern-panel-layout.spec.ts`（新增用例 + 负样本）；门禁 `packages/plugin/scripts/gates/run.mjs` 的 `frontend-runtime` marker 表（含负样本自证） |
| 唯一事实来源 | 用户问题的那一行 + 700px 断点的既有契约：移动端面板 = 品牌图标 + 横向可滑分区按钮条 + 全宽主区（§3.5 面板 P0 起生效） |
| 持久态 | 无（纯 CSS 规则文本，不落盘、不进 state.json） |
| 临时态 | 无 |
| 外部依赖 | 无新增。复现/验收用 headless Chromium（Debian bookworm apt 包实装，Chromium 150）+ 宿主真实 `Modal.module.css`（ui-primitives 0.2.0-rc.2）+ 插件真实注入 CSS（从 `installStyle()` 模板字面量逐字节抽出）+ 真实面板 DOM |
| 注册入口 | 无新增/删除 |
| 删除路径 | 删媒体查询里的 `.dt-panel-navlist{display:contents}` 即回到本次回归（spec 与门禁双双翻红）；再撤 `.dt-panel-navlist` 桌面容器即回 6613a75 之前（会回归「品牌块被卷走」——那是 6613a75 修掉的问题） |
| 兼容对象 | 桌面（>700px）几何零变化（量测对账）；移动端几何回到 6613a75 之前的逐像素形态；Mod 追加分区行为不变（只影响移动端横条里按钮的排布容器） |

## RCA：为什么「按钮占据了整个面板」

用户的因果判断正确，且机制可以精确到行：**回归发生在「桌面新增容器」与「既有移动端
媒体查询」的接缝上**。

1. **700px 断点早已定义移动端形态**（`main.js` 的 `.dt-panel` 媒体查询，本轮改动前
   的原文见下）：`.dt-panel{flex-direction:column}`（面板转纵向）、
   `.dt-panel-nav{width:100%;flex-direction:row;align-items:center;overflow-x:auto;
   overflow-y:hidden;border-right:0;border-bottom:1px solid …}`（导航列变横向滑动
   按钮条）、`.dt-panel-brand-copy{display:none}`（品牌只留图标）、
   `.dt-panel-navcell{flex:none}`（每个分区按钮保持内在宽度，横条可滑）。
2. **6613a75 为「品牌块常驻」新增 `.dt-panel-navlist`**（桌面规则：
   `.dt-panel-navlist{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;
   overflow-y:auto}`——分区清单在这个容器里独占滚动），但该媒体查询只覆盖
   `.dt-panel` / `.dt-panel-nav` / `.dt-panel-brand*` / `.dt-panel-navcell` 四类
   选择器，**没有覆盖新容器**。
3. 于是移动端下：横条（`.dt-panel-nav`，行向）的唯一 flex 子项 `.dt-panel-navlist`
   仍按**列向**排布 18 个分区按钮 → 横条被撑到 667px 高（`.dt-panel` 是列向 flex，
   nav 为 `flex:none`，高度由内容决定）→ `.dt-panel-main{flex:1;min-height:0}` 只剩
   33px、`.dt-panel-body` 高度 0——「按钮占据了整个面板，几乎看不到页面对应内容」。

**量测证据**（headless Chromium 150、CDP 设备模拟 390×844、宿主真实 Modal CSS +
插件真实注入 CSS + 真实面板 DOM，18 个分区含 Mod 追加面）：

| 状态 | nav（横条/导航列） | 主区 | 正文 | 页首内容按钮 |
|---|---|---|---|---|
| 6613a75 之前 | 高 55px（scrollW 1440 横向可滑） | 高 645px | 高 576px | y=276 屏内可见 |
| 6613a75 之后（回归，HEAD 实测） | 高 **667px**（navlist 311×646 竖排） | 高 **33px** | 高 **0px** | y=888 出屏 |
| 修复后 | 高 55px（scrollW 1440） | 高 645px | 高 576px | y=276 屏内可见 |

「修复后」与「6613a75 之前」逐项一致——本修把横条恢复成原形态，而不是另立新形态。
截图对照（同环境）：回归态整屏只剩 18 个竖排分区按钮与底部被裁的标题栏；修复态为
顶部一条横滑按钮条 + 完整页面内容。

## 落法

- **一处插入**：`@media(max-width:700px)` 的 `.dt-panel-nav` 规则之后加
  `.dt-panel-navlist{display:contents}`——清单容器在移动端不生成盒，分区按钮回到
  横条的 flex 流（与 6613a75 之前的 DOM 逐像素同形），横条的 `overflow-x:auto`
  直接承接分区清单的横向滑动。
- **为什么是 `display:contents` 而不是在媒体查询里重述列向/滚动属性**：移动端横条
  的语义是「条里只有按钮」，清单一层不应有任何布局语义；`display:contents` 一并
  消掉「桌面规则未来增补（padding/margin/滚动）漏进移动端」的通道，也不必逐个
  对抗 `flex/direction/min-height/overflow` 四条桌面属性。桌面侧零改动。
- **桌面契约（6613a75）原样保留**：nav 不自滚、清单 `.dt-panel-navlist` 独占滚动、
  品牌块常驻、header `flex:none`——量测对账见下。

## 验证

- **真实浏览器量测**（CDP + 真 Chromium 150，宿主真实 Modal CSS + 插件真实注入 CSS
  + 真实 DOM；断点两侧与常见机型档各抽）：
  - 390×844（手机）：nav 高 55 / clientW 358 / scrollW 1440；主区高 645；正文高 576；
    页首按钮 y=276。navlist 已无盒（display:contents，0×0）。
  - 360×740：nav 55；主区 621；正文 552。
  - 700×800（断点内侧）：横条 55；主区 645。
  - 701×800（断点外侧，桌面）：nav 有效宽 215px 竖列、h 700；主区 438。
  - 1280×800（桌面）：nav 有效宽 215px、h 700；nav 自身 `clientH 700 = scrollH 700`
    （不自滚）、navlist `clientH 629 / scrollH 646`（独占滚动）——6613a75 的桌面契约
    完好；主区 865、正文 631。
- **测试**：`tavern-panel-layout.spec.ts` 新增 1 项——锁定媒体查询整行（横条规则 +
  `.dt-panel-navlist{display:contents}` + `.dt-panel-navcell{flex:none}`），并断言
  媒体查询排在基础规则之后（`display:contents` 的 cascade 前提）；回归形态断言：
  横条里不得再现 `.dt-panel-navlist{display:flex;flex-direction:column`；负样本面
  补近邻（`display:contentsX` 不匹配 marker）。
- **门禁**：`frontend-runtime` 增 1 条 marker（`.dt-panel-navlist{display:contents}`）
  + 1 条负样本（改成 `display:contents-gone` 必须翻红，自检含牙）。
- **端到端**：tsc 零错、15 gates 全 PASS（`frontend-runtime` 的新 marker 与其负样本
  自检同轮通过）、`client/index.js` 随构建刷新（修复入包、桌面契约 marker 同帧在包；
  `index.mjs` 仅 commit stamp 例行前移 ee25288）。测试总项 1577 → 1578（+1 为本次
  新增用例）；全量 JSON 报告实测 **1578 过 / 0 跳**。
- **本机检查偏差如实留档**（与上次坐标容错提交的同源留档一致）：默认预算下全量
  vitest 三轮（含收尾轮 `pnpm run check`）均命中与本改动零交集的已知负载抖动——
  三轮均为 `tavern-store retrieval-matrix` 的 beforeAll 10s hook 预算超时（隔离
  9.36s 通过；JSON 报告确认默认轮的全部 3 个 skipped 都来自该套件，无固有跳过项），
  其中一轮另伴 `memory-maintenance` 的偶发子用例失败（不同轮次失败用例不同＝时序
  竞态特征；该 spec 零引用客户端产物，隔离连跑两次 16/16 全绿）。以同等预算
  （`--hookTimeout=120000`）全量全绿一次、exit 0——判定为机器负载天气，非确定性
  缺陷；留档不改测试预算常量（独立议题）。

## 边界（如实标注）

- **只锁结构与规则文本**：jsdom 无布局引擎，`display:contents` 的真实盒子行为靠
  headless Chromium 量测（本文记录在案），CI 侧由 spec 的规则文本断言 + gates
  marker（含负样本）对账——与 6613a75 的既有边界一致（仓库未引入浏览器布局测试基建）。
- **`display:contents` 兼容面**：现代 Chromium/WebKit/Gecko 全支持（2018+）；DSH
  客户端为现代浏览器内核，无降级路径需求。
- **已知既存小瑕疵（非本次回归、未修）**：`.dt-panel-nav` 基础规则在 content-box 下
  `width:100%` + padding 会比容器宽 16px，移动端横条右缘被 `.dt-panel{overflow:hidden}`
  裁掉（桌面列同理：198 + 16 = 214px 有效宽）。修它要动基础规则文本（门禁 marker 与
  桌面像素都会变），超出本修范围，留档。
- **横条不自动把活动分区滚到可见**（程序化切区，如侧栏「打开游戏面板」入口）：自
  §3.5 横条存在起就如此，非本次回归，未修——移动端导航的信息架构（分组/下拉/
  自动滚动）是独立议题。
- **横条长度随分区数增长**（18 分区实测 scrollW 1440）：Mod 继续追加分区会更长，
  同属上述独立议题。
