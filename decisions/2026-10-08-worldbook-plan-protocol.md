# 世界书面板化方案协议（plan 协议接入工作台面板）

日期：2026-10-08。状态：已实施。关联：提案 0013（`docs/proposals/0013-card-workbench.md`）、
`decisions/2026-10-08-worldbook-full-editing.md`（世界书全字段编辑，其 Alternatives
将本协议裁剪留待独立提案——本文即该提案的落地）、`decisions/2026-10-08-card-full-editing.md`。

## Problem

世界书工具面补全后，全部写入仍走 `confirmed: true` 直写闸门，从不产生方案——
工作台面板（Workbench plans 分区）的 diff 视图对世界书这一主力写作工作量
形同虚设；「面板的工作区工作台方案没有被实际使用」。用户只能在对话里读
Agent 复述的改动，没有独立于对话的、可展开逐字段比对的确认面，与卡侧
（card_plan_propose → 面板 diff → decision）体验割裂。

## Decision

- **方案存储泛化为 kind 判别联合**（`card-workbench/plans.ts`）：`WorkbenchPlan =
  CardPlan | WorldPlan` 同目录共存（`card-workbench/plans/<planId>.json`，planId
  同一空间）；存量卡方案文件无 kind，读取边界归一化为 `'card'`。生命周期 API
  更名为 kind 无关的 `getPlan/listPlans/decidePlan/applyPlan`（list 支持
  kind/character/world/status 过滤，character 过滤对世界书方案恒不命中）。
- **WorldPlan 按条目动作建模**：`{ kind:'world', op:'edit'|'create', world, title,
  entries:[{ uid, action:'update'|'create'|'remove', fields:[{field,
  currentValue?, newValue}], note? }] }`。值类型放宽为条目白名单六类字段的原生
  JSON 形态（string/number/boolean/null/string[]，存储层只保证形状与体量上限，
  白名单在工具层复检）。`create` 方案全部条目为 `create` 动作、uid 按数组顺序
  （与 world_create 同款分配）；`remove` 动作 fields 为空。
- **`world_plan_propose` 工具**：edit 提案要求书已存在、create 提案要求书名空闲；
  currentValue 一律从活书快照（`enabled` 按 `disable` 取反的可编辑形态视角），
  不信任模型复述——diff 面向用户 truthful，与卡侧同款纪律。
- **执行核 `executeWorldPlan`**（对话内 planId 路径与面板 decision 路由共用）：
  过期检测——update 逐字段核对 currentValue 仍在活条目、create 的 uid 尚不存在、
  remove 的条目仍在、建书名仍空闲；字段白名单与范围复检后经 world_put 同款
  应用核（`applyWorldEdits`，从 world_put 直写路径抽出共用）写入，成功才标
  applied。`world_put(planId)` 应用 edit 方案、`world_create(planId)` 应用 create
  方案：planId 给出时直写参数被忽略（与 card_put 对称），confirmed 闸门保留，
  kind/op/world 三重匹配错位即拒绝。
- **面板接线**：GET `card-workbench/plans` 同列两种 kind（新增可选 `kind` 过滤
  参数）；POST decision 按 plan.kind 分派到 executeCardPlan / executeWorldPlan，
  拒绝路径共用。客户端 WorkbenchPlanCard 增加世界书分支：meta 显示
  「世界书 · 书名（· 新建书）」，diff 按条目分组（#uid + 动作徽标 + 逐字段
  当前 → 改为，create 动作无当前值块，标量/数组值分别渲染），中英词条与
  条目分组 CSS 补齐。
- **四个书级生命周期工具不动**：world_delete/world_rename/world_bind/world_copy
  维持 `confirmed` 直写闸门——与卡侧 card_delete/card_restore_original 对称
  （删除/恢复类单步操作不进方案协议），面板 diff 对这类操作不增加信息量。

## Alternatives considered

- **书级操作也换 planId 闸门**（worldbook-full-editing 的 Consequences 曾提示
  「可直接替换」）：删除/改名/挂绑/复制是单决策操作，diff 视图只是把一句话
  换个排版；硬走提案-面板-决定三步反而增加摩擦。裁剪，维持 confirmed。
- **世界书方案独立存储目录**（`world-plans/`）：面板要合并两个列表、planId 空
  间与生命周期 API 全部双份；同目录 kind 判别让 decision 路由与列表天然统一。
  否决。
- **WorldPlan 复用 CardPlan 的 changes 平铺结构**（field 换成 `uid.field` 键）：
  面板 diff 丢失条目分组与动作语义（create/remove 无 current→new 形态），渲染
  要靠字符串约定反推。否决，按条目动作建模。
- **方案值存字符串化形态**（数字/布尔拼进字符串）：执行时再解析回类型引入
  有损往返（trim、本地化数字）；存储层直接放宽值类型更诚实。否决。

## Consequences

- 世界书编辑/建书与卡编辑共用同一确认 UX：提案 → 面板 diff（或对话确认）→
  执行，工作台面板对主力写作工作量真正投入使用；工具总数 21→22。
- 过期检测使「提案后并发直写」不会静默覆盖：字段失配/条目消失/书名被占在
  执行时拒绝并保持 pending，Agent 需重新提案（错误信息指明）。
- 存量 pending 卡方案无需迁移（kind 读取时归一化）；直写路径（不带 planId 的
  world_put/world_create + confirmed）保留，用于对话内即时小改——KERNEL 提示
  词已同步双路径语义。
- world_put 直写路径的编辑应用逻辑与执行核共用 `applyWorldEdits`，后续条目
  编辑语义变化只需改一处。
