# 面板新建世界书与新建预设

日期：2026-10-09。状态：已实施。关联：提案 0013（新建角色卡向导）、`decisions/2026-10-08-worldbook-full-editing.md`（Agent 侧 world_create 工具面）。

## Problem

面板六类 Tavern 资产里，角色卡（提案 0013 向导）、人设、群聊、正则脚本都有新建入口，
世界书与预设是仅剩的两类「只能导入不能创建」的资产——用户想开一本空书或一个空预设，
必须先在别处造好 JSON 文件再导入。角色卡的「新建角色卡」手动路径（空白卡模板 +
CardEditor + import/character 落库）已经证明了面板内创建的交互与数据闭环，本次把它
同构推广到世界书与预设。

## Decision

- **零服务端改动**：创建复用编辑既有的 `PUT world/:name` 与 `PUT preset/:name` 路由。
  创建即「oldName === 新名」的保存——`importWorldFile` / `putPreset` 落盘即建，
  路由的改名分支（oldName ≠ 新名才删旧）天然不触发。PUT preset 侧既有的
  parsePresetOrThrow 校验、activePreset 改名跟随、AgentTavern 投影写穿全部原样继承。
- **空白模板口径**：
  - 世界书 `{ name: '', entries: [] }`：条目缺省值由 WorldBookEditor 的 addEntry 按
    normalizeEntry 口径补全；序列化为 ST 文件形态 `{ entries: {} }`，空对象是
    parseWorldInfoFile 的合法输入（空白书可保存，之后随时补充条目）。
  - 预设 `{ prompts: [], prompt_order: [] }`：detectPresetKind 要求 prompts 与
    prompt_order 同时为数组才认定为 chat-completion，空白模板两者都带上；采样字段
    留空袋由 PresetEditor 的高级 JSON 维护。
- **交互**：导入带内 `+ 新建世界书` / `+ 新建预设` 按钮（对齐角色卡的
  `+ 新建角色卡`），点击即在分区尾部展开既有编辑器（WorldBookEditor / PresetEditor）
  的空白实例；空列表占位文案在创建期间让位。创建成功后世界书展开浏览新书、预设
  停留在编辑态继续填写；均不自动激活（activation 是用户显式选择，与导入语义一致）。
- **重名防护**：面板侧先拦同名（大小写不敏感——落盘 stem 在部分文件系统上不区分
  大小写），报 duplicate 文案指路换名或先删除；与角色卡手动新建同一颗粒度。
  PUT 路由本身的重名覆盖语义（与导入一致）不变——面板拦在前，路由保持无状态。
- **不做向导弹窗**：角色卡向导的存在前提是「Agent 写卡 / 手动编辑」双路径选择；
  世界书与预设没有对应的面板化创作 Agent（写卡 Agent 的 world_create 是卡写作语境），
  单一手动路径不值得多一层选择弹窗。

## Alternatives considered

- **新增 POST world / POST preset 专用创建路由**：与既有 PUT 语义完全重复，还要
  各自处理重名/校验/投影写穿——两份逻辑一份漂移风险。否决，删除这一步。
- **空白预设带出厂提示词条目（如 main/system 占位）**：替用户预设内容违背
  「空白模板」直觉，且 ST 导出预设的 prompts 形态千差万别。否决，空栈起步。
- **重名防护下沉到服务端路由（409 拒绝）**：会改变导入覆盖语义（import/world 与
  PUT world 共用 importWorldFile），破坏「重导同名文件即覆盖」的既有行为。否决，
  面板侧拦截即可。
- **safeFileName 归一后的落盘撞名检测**（如 "A/B" 与 "A_B" 同路径）：角色卡手动
  新建同样只做大小写不敏感比对，异形名撞盘是全资产面共有的低频边角，不单边加码。
  与角色卡口径保持一致，留待统一处理。
- **创建后自动激活新书/新预设**：激活改变 prompt 装配与投影，属于用户显式选择
  （面板各有 activation 控件）。否决。

## Consequences

- 面板六类资产全部具备面板内创建能力，「导入才能开张」的断点清除。
- 世界书/预设创建的落库语义（PUT 路由 fresh-name 创建、空白模板合法性）有
  tavern-command.spec.ts 用例锁定，防止后续路由改造无声破坏面板创建路径。
- 预设空白模板依赖 detectPresetKind 的双数组判定——若未来判定口径变化，
  BLANK_PRESET 需同步（已有用例覆盖，变化会先红）。
