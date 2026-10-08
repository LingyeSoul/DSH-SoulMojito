# 写卡 Agent 世界书编辑创建能力完整扩展

日期：2026-10-08。状态：已实施。关联：提案 0013（`docs/proposals/0013-card-workbench.md`）。

## Problem

工作台的世界书工具面（world_list/world_get/world_put/world_create，2026-10-08 早期补齐）
只开放了条目 `key/content/enabled` 三个字段，且没有任何整书生命周期操作。写卡 Agent
实际写作 Lorebook 时的断点：

1. **高级字段全部不可写**：constant（背景常驻）、order/position/depth（注入位置与顺序）、
   probability（触发概率）、keysecondary/selectiveLogic（副键逻辑）、分组、递归开关、
   sticky/cooldown/delay 定时效果——这些正是 Lorebook 写作的核心手段；面板编辑器反而能改
   其中一部分。新建条目只能拿 normalizeEntry 缺省值，"写一张带常驻背景设定的卡"做不成。
2. **条目删不掉**：只能 `enabled:false` 软禁用，废条目越积越多。
3. **书级操作缺失**：不能删书、不能改名、建好的书挂不到卡上（工具描述明说
   "binds nothing"，用户得自己去面板点），"建书→挂卡→开玩"的闭环断在最后一步。
4. **长文读写有损**：world_get 摘要每条 content 截 500 字符，Agent 想搬运/改写既有长条目
   时拿不到全文；照摘要复述再 world_create 一本"复制品"是静默有损的。

## Decision

- **单一事实源字段表**：新增声明式 `WORLD_ENTRY_FIELDS` 表（38 个实用 ST LoreEntry 字段：
  文本/列表/布尔/整数/可空布尔/可空整数六类，带范围、上限、normalizeEntry 缺省值与 schema
  hint）。world_put 的编辑项 schema、world_create 的种子 schema、入参校验、写映射
  （`enabled → disable` 取反等）、world_get 摘要输出全部由表驱动，替换原先三份手写白名单
  校验。新增字段只改一处。
- **world_put**：既有条目按 uid 只覆盖调用方给出的字段（其余含 extra 袋原样保留）；
  未知 uid 建条目（白名单字段 + normalizeEntry 缺省补全）；新增 `remove: true` 删除既有
  条目（与其它字段互斥，不存在的 uid 报错）。
- **world_get**：新增可选 `uids`（≤32）过滤——命中条目 content 全文返回（不再截 500），
  缺失 uid 以 `missingUids` 上报；摘要常显 key/keysecondary/comment/content/enabled/
  constant/order/position/depth，其余表内字段只在偏离缺省值时上报（输出保持精瘦）。
  **world_list**：每个书附带 `linkedCards`（扫一遍卡库聚合 `extensions.world` 单链接，
  与 material_list 的 boundCards 对称）。
- **四个书级生命周期工具**（全部走 `confirmed: true` 闸门）：
  - `world_delete`：世界书没有原版快照，删除不可逆——**有卡仍链接时直接拒绝**（错误信息
    列出卡名并指路 world_bind 解绑），拒绝比"删完留悬空链接"安全；删除后同步清
    activeWorlds。
  - `world_rename`：写新书 → 删旧书 → **回写所有链接卡的 `extensions.world`** →
    activeWorlds 改名。服务端面板 PUT 路由只做前两步加 activeWorlds，不回写卡链接
    （已知缺口），工具面做全。目标重名/落盘名撞名（safeFileName 归一后同路径）拒绝。
  - `world_bind`：写卡链接 `extensions.world`（挂载）；`unbind: true` 解绑（要求卡当前
    链接的正是这本书，否则报当前链接）。重复绑定幂等（alreadyBound），换绑回报
    previousWorld。走 updateCharacter（tmp+rename 原子写、保留容器）。
  - `world_copy`：getWorld→putWorld 整书逐字复制（uid 不变），无损分叉的唯一正道
    （摘要截断决定了 Agent 手工复刻必有损）；目标重名拒绝，拷贝不挂卡。
- **KERNEL 提示词**同步：读协议（uids 全文引用）、起始任务（建书后用 world_bind 挂卡、
  world_copy 分叉）、边界（全字段白名单 + 书级操作语义）。

## Alternatives considered

- **把世界书纳入 card_plan_propose 面板化方案协议（diff 视图 + decision 路由）**：plans.ts
  的方案类型按卡字段建模，扩到世界书需要新方案类型 + 面板渲染 + 路由改造，是独立的
  确认 UX 特性而非编辑能力；confirmed 闸门已保证安全属性。裁剪，留待独立提案。
- **world_export/world_import 文件工具**：面板导入/导出路由已覆盖文件面；Agent 手上没有
  文件，全字段建书 + world_copy 已覆盖等价能力。裁剪。
- **跨书搬移/合并条目**：world_get(uids 全文) + world_put/world_create 可无损组合，不做
  专门工具。uid 重排同理（order 字段才是注入顺序的正解）。
- **开放 outletName**：ST EM 出口钩子，非写卡场景，需要时走面板/JSON。裁剪。
- **删除时不查卡链接、只在结果里提示**（对齐面板 DELETE 路由）：不可逆操作配悬空链接
  风险，拒绝式更符合"确认协议"精神。否决。
- **world_rename 顺手清掉旧书所有卡链接**（对齐面板路由行为）：链接是卡的资产不是书的，
  跟着改名走才不丢信息。否决。

## Consequences

- 写卡 Agent 的世界书能力从"三字段编辑"升级为全字段创作 + 完整书级生命周期，
  "建书→写作→挂卡"闭环走通；工具总数 16→20。
- world_get 摘要输出对默认条目保持原有体积（高级字段仅在偏离缺省时出现），不放大 token
  占用；uids 全文读取按需付费。
- world_delete 的拒绝式语义要求 Agent 先解绑再删书（两步），换取不可逆操作前的确定性。
- 面板 PUT world 路由不回写卡链接的缺口仍在（本次只补工具面）；后续若修面板路由，
  world_rename 工具行为不变。
- 后续若做世界书面板化方案协议，四个书级工具的 confirmed 闸门可直接替换为 planId 闸门，
  工具签名已按"整书操作"建模，无需拆分。
