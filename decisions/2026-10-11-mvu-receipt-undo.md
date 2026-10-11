# MVU 回执撤销（B-6a）

> 日期：2026-10-11。来源：[JSR/LWB 竞品参考](../docs/exploration/2026-10-11-jsr-lwb-reference.md)
> §3.1/§4 的 B-6 建议（LWB 的 keyed-changes undo 链；LWB 为 PolyForm
> NonCommercial——只复刻可观察语义，重新实现，零代码拷贝）。
> 落点：`packages/plugin/src/mvu.ts`（撤销执行核，文件底部独立节）、
> `packages/plugin/src/index.ts`（POST mvu/receipts/undo 路由）、
> `packages/plugin/client/main.js`（MVU 面板撤销按钮 + undone 灰显）、
> `packages/plugin/tests/mvu-undo.spec.ts`（16 项）。

前置：提案 0012 的回执已存每项变更的 before/after 值、失败项与 reason（C-1 守卫
clamp 标注）——本决策把这份既有数据变成能力：**撤销最近一轮变量结算**。dsh 的
聊天 revision CAS 是并发防护不是语义撤销，本节补的正是语义撤销层。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/src/mvu.ts` 撤销节（纯函数核 + 两个执行核）；路由与事件归 index.ts handleMvuApi |
| 唯一事实来源 | 回执本体 `chat_metadata.mvu.receipts`（恢复计划的唯一输入）；变量按架构：ST 写回 `chat_metadata.variables`，AgentTavern 写回 chat 作用域 VariableStore |
| 持久态 | 回执的 `undoneAt`（ISO 时刻）随聊天落盘——「已撤销」是历史事实，不可进程内丢失；恢复后的变量值随各自存储落盘 |
| 临时态 | 无新增 |
| 外部依赖 | 无新外部依赖；守卫复用 mvu-guard.ts 的 `guardMvuWrite` |
| 注册入口 | HTTP `POST /api/dsh-tavern/mvu/receipts/undo`（handleMvuApi，与 mvu/retry 同族）；面板「撤销最近结算」按钮（MVU 面板失败项重试按钮同区域，内联/弹层两变体） |
| 删除路径 | 删 mvu.ts 撤销节 + index.ts 路由分支与 undo import + main.js 按钮/灰显/locale 键 + 本决策文档 + mvu-undo.spec.ts；已落盘的 `undoneAt` 字段是加法式，旧读取方天然忽略 |
| 兼容对象 | 老格式回执（change 缺 before/after）：明确报「回执数据不完整」，不猜；无回执聊天 400；`readMvuReceipts` 对 `undoneAt` 的是字符串才收——手改数据容错与既有纪律一致 |

## 撤销语义（v1 从严）

- **只能撤销该聊天最新一条有效回执**（newest-first 链）：链头 = 最后一个未标
  `undoneAt` 的回执；撤销后它标 `undoneAt`，次新回执重新成为链头。撤销 N 轮 =
  从最新往回逐次撤销，不会跳轮乱序恢复。
- **撤销 = 恢复该回执每项变更的 before 值**：有 before 的路径整值恢复（深拷贝，
  不与回执数据共享引用）；缺 before 的新增键删除，并修剪因此空掉、且结算前
  本不存在的中间对象（复用守卫 `revertMvuTreePath` 语义，含本次修复的根层
  修剪，见「施工偏差与修复」）。
- **恢复值过 $schema 守卫后落盘**：历史合法值应天然通过；被拒（schema 后来改
  了：类型/枚举/只读/结构）→ 整次撤销失败如实报因，变量不动。守卫会调整值
  （clamp/step——schema 漂移的另一信号）**同样拒绝**：撤销承诺精确恢复 before
  值，不写任何「被调整过的恢复值」。`$schema` 路径无论有无 schema 恒拒（守卫
  契约不可经撤销写入）。clamp 类回执（reason 标注 guard 的）按回执 before 值
  精确恢复——before 本就是 clamp 前的合法值。
- **失败项不参与恢复**：结算失败项从未落盘，回执 changes 里也没有它们，天然
  排除。
- **落盘走聊天 revision CAS**：body.revision 可选预检（客户端本地有才带），
  saveChat 冲突抛 `ChatRevisionConflictError` → HTTP 409 既有通道；AgentTavern
  路径的 chat 作用域变量另有 per-name CAS（`VariableRevisionConflictError` →
  409），删除先行——任何一项冲突都在写入恢复值之前抛出，不部分落回执。
- **撤销后发 chat-saved 事件**：floorCount 传当前楼数（撤销不动楼层，
  `emitChatSaved` 第 4 参）。
- **已全撤销再撤销 / 无回执**：400 分类报错（`MVU_UNDO_ALREADY_UNDONE` /
  `MVU_UNDO_NO_VALID_RECEIPT`），变量不动。

## 两架构（C-1 模式：共享纯函数核 + 两个薄挂接）

纯函数核（mvu.ts，两架构与测试共用）：`latestValidMvuReceipt`（链头判定）、
`planMvuUndoRestores`（回执 → 恢复计划，数据完备性检查在此）、
`screenMvuUndoRestores`（守卫 pass）、`applyMvuUndoRestores`（树写入）。

- **ST（`undoMvuStSettlement`）**：回执在 `chat_metadata`，恢复值写回
  `chat_metadata.variables`；恢复后空树摘键（与结算侧「无变量不写键」导出
  约定一致）。
- **AgentTavern（`undoMvuAgentSettlement`）**：`tavern_variable_settle` 的回执
  与 chat 作用域变量存储，撤销写回同一存储——有 before 值的路径恢复（flat
  条目存在则 CAS 更新，不存在且播种树也已同值则免写），新增键删除。「当前值」
  与 settle 的 before 同源（flat 既有值 ?? 聊天播种树），保证恢复目标与结算时
  读到的 before 视角一致。回执标记仍落 chat_metadata.mvu.receipts + saveChat
  CAS。路由按 `GET mvu/status` 同判据（sessionBindings 里 agent-tavern 绑定）
  改派两个执行核。

## HTTP + 面板

- `POST /api/dsh-tavern/mvu/receipts/undo {character, chatId, revision?}` →
  `200 {ok, undoneTurnKey, restored: [{path, value?}], receipt, revision}` 或
  400（`MVU_UNDO_NO_VALID_RECEIPT` / `MVU_UNDO_ALREADY_UNDONE` /
  `MVU_UNDO_INCOMPLETE_RECEIPT` / `MVU_UNDO_UNDO_REJECTED`，message 带逐路径
  报因）；404 未知聊天；409 并发冲突。
- MVU 面板（内联/弹层两变体，失败项重试按钮同区域）加「撤销最近结算」按钮：
  链头判定与客户端同判据（最后一个未标 undoneAt 的回执），全已撤销/无回执时
  隐藏；点击走「loadChat 强刷 → undo → reload」既有模式，409 走既有重取通道。
  已撤销回执灰显（opacity + 变更行删除线）+「已撤销」徽标，与状态徽标并排。
  撤销按钮对两架构开放（撤销的是回执记录的变量变更，与重跑渲染无关）；
  GET mvu/status 的回执投影天然带 undoneAt（灰显数据源）。

## 施工偏差与修复（半成品盘点）

上一个施工段留下的是完整骨架 + 一处真 bug：`revertMvuTreePath` 的空对象修剪
循环在修剪**最顶层段**时，宿主用 `getMvuTreePath(tree, '')` 取——空路径 split
出 `['']`，返回 undefined → break，顶层空键删不掉。撤销「首轮结算新增 `mvu.*`
后整树清空」时残留 `variables: {mvu: {}}`，摘键约定失效。修复：被修剪段是顶层
时宿主直取树根（mvu.ts `revertMvuTreePath`）。这是守卫回滚路径的同类潜伏 bug
（守卫拒绝新增顶层键同样留 `{}` 残壳），一处修复两处受益——守卫基线测试
（mvu-guard / tavern-mvu）零改动通过，确认无行为回归被锁死。

## 否决项（v2 候选）

- **任意轮撤销 / 撤销到指定回执**：跳轮恢复在中间轮有外部写入（宏、variable_set
  工具）时会静默覆盖它们，v1 从严只开 newest-first 链。
- **撤销的撤销（redo）**：回执链会需要第三态（undone/redone），面板呈现与链头
  判定都复杂化；需要时基于本节的恢复计划机制加。
- **跨聊天批量撤销**：无真实场景。
- **AgentTavern 播种树回写**：撤销只写 flat store，不动 `chat_metadata.variables`
  播种树（与 settle 写入面一致——播种树是 InitialVariables 重算的产物，非用户
  状态）。

## 测试

`packages/plugin/tests/mvu-undo.spec.ts`（16 项）：

- 纯函数核 5 项：链头判定、恢复计划（含失败项不参与、老格式数据不完整拒绝）、
  树应用（整值恢复/叶子删除/空中间对象修剪）、守卫筛选（enum/range/ro/$schema
  拒绝与 would-adjust 拒绝、历史合法值放行）；
- ST 集成 9 项：恢复 before 值（clamp 类回执精确恢复）+ 回执标 undone + 状态栏
  重渲（renderedHtml 随恢复值变化）、逐次撤销两轮 newest-first、全已撤销 400
  分类、无回执 400 分类、失败项不参与、守卫拒绝（枚举收窄/区间收紧）整次不动
  且回执不标 undone、revision 冲突 409 + 未知聊天 404、chat-saved 带
  floorCount、空树摘键、删除键恢复/新增键删除；
- AgentTavern 2 项：settle 回执逐次撤销写回 flat store（含播种树免写路径）、
  播种值作 before 的回执撤销（flat 按需创建条目覆盖回播种值）。

回归：tavern-mvu / mvu-guard / agent-tavern-mvu-settle 基线零改动通过。
