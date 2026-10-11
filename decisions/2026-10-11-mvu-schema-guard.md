# MVU `$schema` 变量写入守卫

> 日期：2026-10-11。提案：0012 延伸（P4）。竞品参考：`docs/exploration/2026-10-11-jsr-lwb-reference.md`
> §3.2 / §4 C-1（LittleWhiteBox variables/state2，280 行规格书）。clean-room 重新实现，
> 未复制任何 LWB 代码。

## 1. 动机

MVU 变量结算（提案 0012）是确定性脚本结算 + 回执，但结算**结果**完全由卡内脚本/
模型产出的 setvar 决定——模型写坏结构（类型漂移、越界、夹带临时字段、整树替换丢字段）
只能事后靠人眼从回执里发现。LWB state2 的核心洞察：`$schema` 模板**不是提示词建议
而是写入守卫**，结构/类型锁定、`$range` clamp、`$enum` 校验、`$ro` 只读全部确定性执行。
给本插件结算执行器加守卫层，把「模型写坏结构」这一整类失败消灭在写入时。

## 2. Schema 来源（卡内 stat_data 在本仓库的承载）

本仓库没有字面 `stat_data` 字段；卡内 MVU 数据的承载是
`data.extensions.agentTavern`（0013 工作台 / `card_apply_mvu` 的产物：`statusTemplate`、
`initialVariables`）。`$schema` 是变量树根的可选子树，按以下优先级解析
（`mvu-guard.ts readMvuSchema`，先到先得）：

1. **聊天变量树根 `$schema`**（`chat_metadata.variables.$schema`）——新聊天由卡
   `initialVariables` 整树深拷贝播种而来（index.ts chats 路由），支持按聊天演进；
2. **卡 `data.extensions.agentTavern.initialVariables.$schema`**——覆盖 schema 上卡
   之前创建的旧聊天，以及变量权威源在 chat 作用域 VariableStore 的 AgentTavern 聊天；
3. **`chat_metadata.initial_variables.$schema`**——世界书 `[InitialVariables]` 条目
   携带（每次生成重算，与 0008 模板变量同源）。

剥离纪律（**只特判 `$schema` 这一个键**，不一刀切剥离 `$` 开头键，兼容既有卡）：

| 消费面 | 处理 |
|---|---|
| 回执 diff（结算投影） | `diffVariables` 两侧剥离根 `$schema`，永不作为变量变更入回执 |
| 状态栏渲染 | `renderMvuStatusTemplate` 的 local/initial 绑定剥离 |
| `GET mvu/status` 载荷 | `displayVariables` 剥离（含 AgentTavern overlay 分支）；`POST mvu/retry` 响应的 `variables` 同 |
| chat 作用域 VariableStore | 无需剥离——store 名字校验（`^[\p{L}_][\p{L}\p{N}_.-]{0,63}$`）本就不含 `$` |
| 模板运行时 getvar | 不剥离（绑活树写穿语义不能换成拷贝；`$schema` 在模板作用域是惰性数据，非 UI 泄漏） |

`$schema` 子树本身只读：结算写入 `$schema` 或其下路径 → 失败项（readonly 分类），
ST 整树 pass 会把模板写穿改动过的 `$schema` 回滚到基线（守卫不可自改）。

## 3. 守卫语义（最终形态）

守卫核心是纯函数 `guardMvuWrite(schema, path, value, current)`（mvu-guard.ts），
模板语法见该文件头注释（原语字面量按例定类型；`$range/$step/$enum/$ro/$type` 指令键；
`"*"` 通配动态对象；`{}` 开放对象；数组首元素为项模板）。

| 规则 | 行为 | 回执归类 |
|---|---|---|
| 结构锁定 | 模板对象含子键定义时，写入不得引入模板外新键；整对象写入导致既有模板字段丢失 = 删模板字段，拒绝；标量模板下写嵌套路径、数组模板下写非索引路径，拒绝 | 失败项（structure） |
| `"*"` 通配键 | 任意子键允许，子键按通配模板校验 | — |
| 空对象 `{}` | 开放：子键任意、不校验 | — |
| 数组项模板 | 每项按首元素模板校验（含嵌套约束递归） | 违规进失败项 |
| 类型锁定 | number/string/boolean/object/array；**不强转**（数字字符串也拒绝） | 失败项（type-mismatch） |
| `$range: [min,max]` | 数字越界 **clamp 到边界**（首写与既有值无关，纯边界收拢） | 正常回执，`reason` 标注 guard clamp |
| `$step: n` | **单次写变更幅度截断**到 `±n`（既有值已知时），截断后再 range clamp | 正常回执，`reason` 标注 guard step/clamp |
| `$enum: [...]` | 非成员（严格比较）拒绝，不静默修正 | 失败项（enum-violation） |
| `$ro: true` | 会改变值的写入拒绝（含删除与首写）；**同值幂等写放行** | 失败项（readonly） |
| 删除模板字段 | 拒绝（模板定义的字段不能删）；未声明键删除放行 | 失败项（structure） |
| 根命名空间 | 根 `$schema` 是命名空间映射不是锁：未声明的顶层名不受守卫（非 MVU chat 变量可共存） | — |
| 无 `$schema` | 恒等放行，行为与 C-1 之前完全一致（golden 测试锁死） | — |

**clamp 与 reject 的分类理由**：数值越界是「方向正确、幅度失准」——clamp 后仍是
合法状态，静默收拢 + 回执如实记录前后值与原因，不打断叙事；枚举/类型/结构/只读是
「值本身不合法或不可写」——任何静默修正（就近取枚举、强转类型）都会制造模型看不见
的假状态，失败项 + 重试路径让模型在下一次结算里自己改对。这与 state2 的取向一致
（range clamp / enum reject）。

## 4. 两个消费面（结算执行器的真实形态）

README「ST 侧走同一结算执行器」经核实应读作「同一结算**语义与回执投影**」——
两架构的写入路径是两个，守卫挂两处、共享同一纯函数核：

1. **ST 生成 + `POST mvu/retry`**（mvu.ts `applyMvuSettlementGuard`）：模板输出渲染
   写穿完成后、回执 diff 之前做整树 pass——按叶子路径 diff 逐项守卫，clamp 写回活树
   （进正常回执，`changeNotes` 附 `reason`），reject 把该路径回滚到基线值（含空中间
   对象修剪与空树摘键）并进 `failures`。生成路径失败项使回执 status='failed'；retry
   路径维持既有「retry 不产生 failed 状态、失败项只进 failures」约定。
2. **AgentTavern `tavern_variable_settle`**（agent.ts 工具内逐项）：`store.set` 前按
   路径守卫；clamp 值落库并附 `reason`（回执 change 与审计线都带）；reject 走既有单项
   失败路径（`failed[]` + 回执 failures + 审计线对齐），重试即新一次结算、仍过守卫。
   「当前值」取 flat 既有值 ?? 聊天播种树（ro/step 判定与回执 before 同源）。

失败项错误串统一为 `${name}: guard ${kind}: ${reason}`，kind ∈
{type-mismatch, enum-violation, readonly, structure}，走现有失败项重试路径不改协议。
`MvuVariableChange` 新增可选 `reason` 字段（clamp/step 说明），`readMvuReceipts` 透传。

## 5. 与 LWB state2 的差异（及理由）

| # | state2 | 本实现 | 理由 |
|---|---|---|---|
| 1 | 数字字符串宽松转换（"3"→3） | **不转换，直接 type-mismatch** | 规格明确「不强转」；静默转换掩盖模型错误，回执失败项 + 重试的代价在本架构里很低 |
| 2 | set 是整体替换，模板字段必须齐全 | **不要求字段齐全**；只有写入导致既有模板字段丢失才拒绝 | 本插件结算模型是路径写（ST 叶子 diff 天然逐路径；settle 是逐项 dotted name），部分更新是常态；LWB 的完整性要求源于其整树替换语义 |
| 3 | `$step` 限制 inc 的 delta | **单次写变更幅度截断**（绝对值写入翻译 inc 语义） | 本插件没有 inc 原语；按幅度截断保留了 state2 的反漂移意图（模型一次性 +50 好感被压回 ±step） |
| 4 | `$ro` 无条件拒绝任何 set | 拒绝「会改变值的写入」，同值幂等写放行 | ST 叶子 diff 只送变更路径，两面对齐；模板每楼重写同值 ro 字段不产生噪音失败 |
| 5 | `<state>` 文本块 + 手写 parser（544+827+351 行） | JSON `$schema` 子树 + 纯函数模块（~400 行） | 本插件变量本就是 JSON 树，不需要文本协议；卡作者用 0013 工作台产出 schema |
| 6 | 路径规则表 + 通配匹配（`*` / `[*]` 打分回溯） | 模板树按段下走（数组→项模板、对象→命名/通配子键） | 语义等价（数组项=`[*]`、通配键=`*`），树形解析更贴合 JSON 声明 |

已知取舍：ST 路径守卫是**写穿后置 pass**——正文里内插的数值（`<%= getvar(...) %>`）
可能是 clamp 前原值，变量面/状态栏/回执以守卫后的值为准（回执 reason 明示 clamp，
分歧可见可解释）。要连正文一起守卫需要把守卫下沉到模板运行时 setvar（改动面大，
且 tavern-template 是共享包），留待有真实需求再立项。

## 6. 落点清单

- `packages/plugin/src/mvu-guard.ts`：守卫核心（schema 解析 / guardMvuWrite / strip /
  readMvuSchema / getMvuTreePath），纯函数无 I/O。
- `packages/plugin/src/mvu.ts`：`applyMvuSettlementGuard`（ST 整树 pass）、`diffVariables`
  剥离 `$schema`、`MvuVariableChange.reason` + `readMvuReceipts` 透传、
  `recordMvuTurnReceipt.changeNotes`、`renderMvuStatusTemplate` 剥离、
  `retryMvuSettlement` 接守卫 + 响应剥离。
- `packages/plugin/src/index.ts`：`runGeneration` 结算守卫挂接（写穿后、回执前）、
  `mvu/status` displayVariables 剥离。
- `packages/plugin/src/agent-tavern/agent.ts`：`tavern_variable_settle` 逐项守卫
  （含 store 名字校验抛错的守卫归因、before 取覆盖视角当前值）。
- 测试：`packages/plugin/tests/mvu-guard.spec.ts`（纯函数 + ST 链路 24 项）、
  `packages/plugin/tests/agent-tavern-mvu-guard.spec.ts`（settle 工具 7 项）；
  既有 `tavern-mvu.spec.ts` / `agent-tavern-mvu-settle.spec.ts` 未改动全绿（golden 锁）。
