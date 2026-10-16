# 侧栏两分区固定高度 + 独占滚动，写卡工作台默认收起

> 日期：2026-10-16。用户需求：「让侧边栏 写卡工作台默认保持收起，并且 酒馆区域和
> 写卡工作台区域固定一定高度，并且支持滚动，防止会话，角色卡过多导致原始会话工作区
> 被挤压到看不见」。两条都落在 `TavernSidebar`（自绘侧栏）上，一并处理。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/client/main.js`（`TavernSidebar` 的分区结构与 `sidebarCollapsed` 初值 + `.dt-sidebar-*` 规则）；测试 `packages/plugin/tests/tavern-sidebar-layout.spec.ts`（新增）；门禁 `scripts/gates/run.mjs` 的 `frontend-runtime` marker 表 |
| 唯一事实来源 | 用户问题的那一行：分区高度由滚动容器上限决定，不再由内容量决定；写卡工作台的默认态进 store 初值 |
| 持久态 | 无（纯前端渲染结构与折叠态，不落盘、不进 state.json、不进 localStorage——沿用 2026-10-10 决策的「重载回默认态」口径） |
| 临时态 | `sidebarCollapsed`（客户端 store 内存态，重载即回默认；docked 侧栏门户与面板聊天分区两个挂载点共享） |
| 外部依赖 | 无新增。宿主侧栏列（flex 列：本插件插槽 `flex:none` + 原生会话树 `flex:1`）与既有 `--dsh-session-list-edge-inset` 变量不变 |
| 注册入口 | 无新增 slot/service/路由；面板分区注册表（`chats` 分区复用同一 `TavernSidebar`）不变 |
| 删除路径 | 删 `.dt-sidebar-scroll` 两处包装（还原成 `React.Fragment` / 直接渲染 `WorkbenchList`）+ 删 CSS 规则 + `sidebarCollapsed.workbench` 回 `false` 即回旧行为（会回归本反馈；spec 与 gates 负样本都会翻红提醒） |
| 兼容对象 | 分区折叠契约（2026-10-10）不变：标题行即折叠钮、折叠只藏内容、标题行常驻、`aria-expanded` 与 chevron 旋转惯例不动；管理面板 `chats` 分区与 floating 形态共用同一组件，规则同款生效 |

## RCA：被挤没的是哪一块（证据坐标）

用户的描述是「原始会话工作区被挤压到看不见」。侧栏是注入在宿主会话列表**上方**的
一个 `flex:none` 插槽（`[data-dsh-soulmojito-sidebar-host]`），整块高度完全由内容
决定——先量再改：

1. **复现环境**：headless Chromium（Playwright MCP）+ 宿主侧栏列的真实几何
   （`display:flex;flex-direction:column;height:100vh` 列：插件插槽 `flex:none` +
   原生会话树 `flex:1;min-height:0;overflow-y:auto`）+ 本插件真实注入 CSS
   （从 `installStyle()` 的模板字面量逐字节取出，68361 字节）+ 真实 DOM
   （14 个角色 × 每角色 5 条会话 + 分组子标题 + 12 条写卡工作台会话）。
2. **旧形态复现了用户的现象**：整列 900px 高时插件插槽量到 **2927px**，
   原生会话树只剩 **1px**（可视行数 0）——「挤压到看不见」当场复现。
   侧栏区块本身无高度上限，角色卡/会话越多，插槽越高。
3. **为什么现在才暴露**：写卡工作台会话是从 0013 起持续累积的一类列表
   （每个来源聊天一个工作会话 + 自由工作台），且它的默认态是**展开**——两块
   分区的自然高度相加，宿主会话树被推出可视区；两块内容都无法让位。
4. **命中用户需求的两条**：①默认收起写卡工作台（标题行的「+」钮折叠态仍可新建）；
   ②给两分区各自一个固定高度上限 + 独占滚动，使插槽总高与内容量解耦。

## 落法

- **两分区内容各进一个滚动容器**：`.dt-sidebar-scroll`（
  `display:flex;flex-direction:column;min-height:0;max-height:min(320px,32vh);
  overflow-y:auto;overflow-x:hidden`）+ 分区类 `dt-sidebar-tavern` /
  `dt-sidebar-workbench`。酒馆门控从 `React.Fragment` 换成带类名的 `div`
  （角色列表、空态、「分组」子标题与分组列表仍在门控内，折叠语义不变）；
  写卡工作台门控把 `WorkbenchList` 包进同款容器。上限只写一条规则（DRY）：
  两分区共用同一个 `min(320px,32vh)`——320px 兜住高屏（避免占满），32vh 兜住
  矮屏（总占位随视口收缩）。
- **写卡工作台默认收起**：`sidebarCollapsed` 初值
  `{ tavern: false, workbench: true }`。默认态进 store 初值（沿用 2026-10-10
  决策：重载回默认，不进 localStorage）；两挂载点仍共享同一份折叠态。
- **不给插槽本身设上限**：分区各自封顶后插槽总高已与内容量解耦，若再给
  `[data-dsh-soulmojito-sidebar-host]` 加 `max-height` 会出现「插槽 + 分区」双层
  嵌套滚动（滚到边界后滚动权交接，手感断裂）。spec 用一条负断言钉住这一点。

## 验证

- **真实浏览器量测（headless Chromium，同上复现环境）**——视口 1280×宽度 ×
  三档高度；「旧形态」= 无包装容器；「两分区全开」= 最坏情形；「默认形态」=
  写卡工作台收起：

  | 视口高 | 旧形态：原生树 | 两分区全开：原生树 | 默认形态：原生树 | 酒馆区 client/scroll |
  |---|---|---|---|---|
  | 900 | **1px（0 行）** | 248px（8 行） | 536px（17 行） | 288 / 2532 |
  | 700 | **1px（0 行）** | 176px（5 行） | 400px（13 行） | 224 / 2532 |
  | 1200 | **1px（0 行）** | 484px（16 行） | 804px（26 行） | 320 / 2532 |

  写卡工作台区同样受限（900px 档：client 288 / scroll 341）。把酒馆区
  `scrollTop` 推到最大值时，原生会话树 `getBoundingClientRect().top` 恒定
  （900px 档 660→660）——滚动只发生在分区容器内，宿主会话树不会被卷动。
  截图：`.playwright-mcp/sidebar-before.png`（旧形态整屏只有侧栏内容）、
  `sidebar-after-full.png`（两分区全开，各自滚动条 + 原生树可见）、
  `sidebar-default-full.png`（默认形态：酒馆固定高度可滚、写卡工作台收起、原生树 17 行）。
  内容不足上限时不占空箱（同页把酒馆区内容换成一行：容器 clientHeight 288→34、
  原生树 536→790px）——`max-height` 是上限语义，不是绝对值。
- **几何界（可推导的保证）**：分区合计 < `2 × min(320px,32vh) + 60px`（两条标题行 +
  边距），即视口高 H ≤ 1000px 时插槽占位 ≤ `0.64H + 60px`、原生会话树至少保有
  `0.36H − 60px`（H=900 → 264px；H=700 → 192px）——「挤压到看不见」在结构上不再可能。
- **测试**：新增 `tavern-sidebar-layout.spec.ts`（6 项：两容器结构 + 括号闭合关系、
  酒馆整块在容器内、`WorkbenchList` 在容器内、固定高度 + 滚动规则、默认收起、
  近邻负样本）。全量 `pnpm exec vitest run --hookTimeout=120000`：**105 文件
  1698 过 +1 跳**（Windows 检出：`host-package.spec.ts` 的 POSIX-only 用例）。
- **门禁**：`frontend-runtime` 新增 4 条 marker（两分区容器类、唯一一条固定高度 +
  滚动规则、`sidebarCollapsed` 初值），每条配负样本自证有牙（容器去掉、规则换成
  `overflow:visible`、默认态回展开分别翻红）。`node packages/plugin/scripts/gates/run.mjs`
  15 gates 全 PASS。
- **构建**：`pnpm run build:plugin` 重出 `client/index.js`（dist 入库，仓库无
  release 通道）。

## 边界（如实标注）

- **只锁结构，不锁像素**：与 2026-10-14 的面板外壳修订同因——jsdom 无布局引擎，
  量不出「谁在滚」。CI 锁结构与规则文本，真实几何靠本次 headless Chromium 量测
  （上表）记录在案；若日后要机械守住，需要把 headless 浏览器纳入 CI 依赖。
- **上限是「够用」而非「最优」**：`min(320px,32vh)` 是按 900/700/1200 三档量测取
  的值，未做用户端 A/B。矮屏（H≈600）下两分区全开时原生树约 156px——可见但偏窄；
  真到那一步的正确动作是分区内紧凑行高/搜索，本修不引入（YAGNI）。
- **「固定一定高度」取上限语义（`max-height`）而非绝对值（`height`）**：内容少时
  容器随内容收缩、原生会话树吃掉空出来的空间（量测：酒馆区内容换成一行后容器
  288→34px、原生树 536→790px）。若改成绝对值，角色只有一两个时会留一大块空箱、
  反而牺牲宿主会话树——与本次需求的目标相悖。
- **写卡工作台「收起」不等于「隐藏」**：标题行常驻、`aria-expanded="false"`、
  「+」钮折叠态可用（新建自由写卡工作台）；已有工作台会话要切回主视图，需展开
  分区——这是默认收起的必然代价。
- **`sidebarCollapsed` 仍不进 localStorage**：重载回默认（酒馆展开 / 写卡工作台
  收起）。若用户希望记住手动展开态，是独立需求（会引入客户端首个 localStorage
  先例），本次不扩面。
- **floating 形态仅继承 CSS**：`.dt-sidebar-floating` 无独立规则（当前无挂载点传
  `floating`/`onClose`），两容器的上限规则对它是同款生效，未单独验收。
