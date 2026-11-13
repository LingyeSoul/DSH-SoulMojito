# 侧边栏分区折叠状态跨重载记忆

> 日期：2026-11-13。来源：用户需求「侧边栏 酒馆和写卡工作台记忆折叠状态」。
> 落点：`packages/plugin/client-src/50-store-core.js`（持久化读写与 store 初值）、
> `packages/plugin/client-src/87-ui-sidebar.js`（toggle 写入口）；测试
> `packages/plugin/tests/tavern-sidebar-layout.spec.ts`；门禁
> `packages/plugin/scripts/gates/run.mjs` 的 `frontend-runtime` marker 表。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | client half 的 `sidebarCollapsed` store 字段：初值由 `readSidebarCollapsed()` 提供，唯一写入口是 `TavernSidebar` 的 `toggleSidebarSection`（经 `writeSidebarCollapsed` 落盘） |
| 唯一事实来源 | 宿主页 `localStorage` 的 `dsh-soulmojito:sidebar-collapsed` 键；运行时以 store 快照为准，`localStorage` 只在初值与 toggle 时读写 |
| 持久态及理由 | 两个布尔值必须跨页面重载保留——这正是本次需求；值很小且属于当前浏览器/设备，放宿主页 `localStorage`，不写 `state.json`、不触发 store revision |
| 临时态 | store 里的 `sidebarCollapsed` 仍是 React 快照（docked 侧栏门户与面板聊天分区两个挂载点共享）；没有“未保存”缓冲，toggle 即写 |
| 外部依赖 | 宿主页 `window.localStorage`（浏览器同源存储）；读取/写入失败只发可见 `console.warn`，不阻断侧栏渲染 |
| 注册入口 | 无新增 slot/路由/服务；沿用既有 `TavernSidebar` 两个挂载点与 `sidebarCollapsed` store 字段 |
| 删除路径 | 删三个 helper 与常量、`sidebarCollapsed` 初值改回字面量、toggle 改回 `update({ sidebarCollapsed: next })`、删 spec 的 storage 用例与 gate marker；`localStorage` 里的旧键不影响功能（无读取方） |
| 兼容对象 | 旧版本留下的无该键状态 → 回默认（酒馆展开、写卡工作台收起）；坏 JSON、部分字段、错误类型 → 逐字段归一；两个既有挂载点行为不变 |

## Problem

`2026-10-10-sidebar-section-collapse.md` 把折叠态放进 client store，明确「页面
重载随 store 回默认全展开」；`2026-10-16-sidebar-region-scroll-and-workbench-collapsed.md`
把写卡工作台默认改成收起，并在边界里写明「若用户希望记住手动展开态，是独立需求
（会引入客户端首个 localStorage 先例），本次不扩面」。用户现在提出这条独立需求：
每次重载后手动展开/收起的两个分区都回到默认，长会话工作流里要重复操作。

本次只解决「记住」：两个分区的折叠布尔值跨重载保留。不改变默认值本身（酒馆
展开、写卡工作台收起），也不改变折叠交互（标题行即折叠钮、折叠只藏内容、标题行
常驻、「+」钮在折叠态仍可新建）。

## Decision

- **存宿主页 `localStorage`**：键 `dsh-soulmojito:sidebar-collapsed`，值为
  `{"tavern":boolean,"workbench":boolean}`。这是客户端 UI 偏好，不是 Tavern
  资产或聊天事实；写 `state.json` 会把每次点击变成一次磁盘写与 revision 变更，
  收益为零。
- **读取时逐字段归一**：`normalizeSidebarCollapsed` 只接受布尔字段；缺失、非对象、
  数组、错误类型逐项回落到 `SIDEBAR_COLLAPSED_DEFAULT`
  （`{ tavern: false, workbench: true }`）。坏 JSON 与不可读存储发
  `console.warn` 后回默认，侧栏不因偏好存储失败而空白——与既有
  `loadFrontendStorage` 的「enhancement, not a display gate」口径一致。
- **toggle 写穿同一个归一器**：`writeSidebarCollapsed(next)` 先归一化再
  `JSON.stringify` 落盘，返回归一后的对象写回 store。坏掉的存量 payload 会在
  下一次点击时被完整合法对象覆盖；写入失败只警告，内存态仍然生效，本次会话内
  折叠行为不受影响。
- **初值在模块求值时读一次**：`sidebarCollapsed: readSidebarCollapsed()` 替掉
  字面量初值。client half 每个宿主页面生命周期只求值一次，重载即重新读；两个
  挂载点继续共享 store 里的同一份值，一处折叠两处同步的既有契约不变。
- **不做跨标签页实时同步**：没有监听 `storage` 事件。当前需求是「重载后记得」，
  同页两挂载点已由 store 同步；跨标签页联动是另一条需求，YAGNI。

## Alternatives considered

- **写 `state.json` / 新增服务端偏好路由**：跨设备一致，但每次点击触发磁盘写、
  revision 轮询与并发冲突面；折叠态是浏览器 UI 偏好，按设备保留更合理。否决。
- **`sessionStorage`**：只跨重载不跨浏览器重启，仍会丢；需求是“记忆”，不做半程。
  否决。
- **组件内 `useState` + 各自读写**：docked 侧栏门户与面板聊天分区两个实例会各自
  持有初值，一处折叠另一处不同步，还要各自处理存储失败。否决，沿用 store 单点。
- **监听 `storage` 事件做跨标签页同步**：增加事件生命周期与卸载清理，当前没有
  多标签同时操作侧栏的场景。否决，留待真实诉求。
- **记住每角色/每分组的展开态**：超出本次需求；角色条目自身的 `expanded` /
  `expandedGroup` 仍是组件态，重载回默认。否决，避免把一次小需求扩成通用 UI
  状态持久化层。

## Verification

- **行为 spec（真实产物源，非字面量断言）**：
  `tavern-sidebar-layout.spec.ts` 从 `client/main.js` 截取
  `normalizeSidebarCollapsed` / `readSidebarCollapsed` / `writeSidebarCollapsed`
  的真实函数体，在假 `window.localStorage` 上执行，覆盖：无键回默认、部分字段
  补默认、错误类型逐项回默认、坏 JSON 警告后回默认、合法值 round-trip、存储
  `getItem`/`setItem` 抛错时回默认/仍返回归一值且各留一条警告。另有结构断言锁
  store 初值读取、toggle 写入口与近邻负样本。
- **门禁**：`frontend-runtime` 新增 4 条必需 marker（存储键、默认值、store 初值、
  toggle 写入），并新增 3 条负样本（初值退回硬编码、key 改名、toggle 绕过持久化），
  与既有写卡工作台默认值负样本一起自证有牙。
- **全链路**：`pnpm run check`（tsc + vitest + build:plugin + 21 gates）通过；
  重建后的 `client/main.js` / `client/index.js` 入库。实测数字记录在当次交付说明，
  README 测试基线同步更新。

## Boundaries

- **只记忆两个分区标题**：角色条目与分组的展开层级仍是组件态，重载回默认。
- **按浏览器/设备隔离**：`localStorage` 跟着宿主页源走；清站点数据、换浏览器或
  换设备会回默认。这是“记忆”的边界，不是缺陷。
- **存储不可用时降级为不记忆**：控制台有明确警告，UI 不报错、不空白；这是偏好类
  数据的可接受失败面，不套用业务数据的 fail-closed 口径。
- **默认值不变**：没有存量键时仍是酒馆展开、写卡工作台收起（2026-10-16 决策）。
