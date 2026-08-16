# 施工计划：AgentTavern 原生 AgentLoop

> 日期：2026-08-16。状态：实施中（M0-M3 已完成，M4-M5 待执行；M6 受宿主能力阻塞）。
> 架构来源：提交 `0f2dc4cc2cb0fc7f8534f6d00d911b10e34c0bca` 中的
> `docs/proposals/0004-agent-tavern-architecture.md` 与
> `docs/exploration/2026-08-16-dsh-agentloop-native-audit.md`。
> 目标宿主：DSH `0.1.0-rc.6`；完整验证基线为 `pnpm run check`。

> 执行记录：DSH `@deepseek-ai/dsh@0.1.0-rc.6` 已复制到工作区
> `.npm-cache/dsh-runtime`，包含 `lib` 和完整 `node_modules`。插件 gates 优先使用该本地
> runtime，避免依赖受限的全局 npm 安装；`node .npm-cache/dsh-runtime/lib/bin.js --version`
> 已验证可运行。

## 1. 交付目标

第一条可发布链路只实现单角色 AgentTavern 会话的 `dsh-native` 模式：新会话挂载
`agent-tavern` preset，使用 DSH 原生 composer、AgentLoop、工具执行、取消、错误和统计，
再把原生 user/assistant 事件幂等投影到 Tavern JSONL。现有会话保持 ST 架构，继续使用
`/api/dsh-tavern/generate`、swipe、regenerate、STscript 和群聊语义。

本计划把 `agent-managed` 单独列为宿主依赖里程碑。只有 DSH 同时提供可重建的
`agent/context` 请求投影和与 effective projection 协同的 compaction 策略后，产品才允许
启用它；缺少能力时 UI 和服务端都必须明确拒绝，不能回退到伪 managed 模式。

## 2. 必须保持的不变量

1. AgentTavern 的模型请求只能来自 DSH AgentLoop；AgentTavern 模块不得调用
   `ctx.llm.stream`，也不得把 `/generate` 当作失败后备。
2. 缺少 `architecture` 的历史 binding 一律解释为 `st`，保证升级不改变已有会话；只有
   已明确为 `agent-tavern` 且缺少 `contextMode` 的 binding 才补为 `dsh-native`。
3. `defaultArchitecture` 和 `defaultContextMode` 只影响新建会话。MVP 默认值分别为
   `agent-tavern` 和 `dsh-native`；群聊在宿主没有 actor 元数据前强制创建为 `st`。
4. AgentTavern 的 prompt、工具和权限必须按 agent/session 作用域挂载；现有全局
   `activeAgentPrompt` 不得成为 AgentTavern 身份注入点。
5. DSH session event log 是 AgentTavern turn 的执行事实来源；JSONL 是可导出、可分支的
   派生投影。投影失败不得回滚已完成的原生 turn，但必须可诊断、可重放。
6. `dsh-native` 不注册历史投影，不主动调用 AgentTavern compaction；上下文容量始终服从
   当前 provider/model route 和 DSH pressure/overflow policy。
7. 记忆、变量和检索结果都是有来源、作用域、revision 与大小上限的数据，不得被 kernel
   当作系统指令。Agent 不能通过工具参数指定或伪造 session 身份。

## 3. 目标模块与 seam

| 模块 | Interface 与职责 | 文件落点 |
|---|---|---|
| session binding | 解析、迁移和校验 session 级 architecture/context mode；调用方不接触兼容分支 | `packages/tavern-store/src/store.ts`，必要时拆到 `session-binding.ts` |
| `MemoryStore` | `search/read/put/forget`；内部完成作用域校验、CAS、软删除、审计和确定性词法排序 | `packages/tavern-store/src/memory.ts` |
| `VariableStore` | `get/set/patch/delete/list`；内部完成 typed JSON、限额、CAS 和原子批量写入 | `packages/tavern-store/src/variable.ts` |
| AgentTavern runtime | 根据真实 `agent.id` 解析 binding，挂载 preset、kernel 与工具，并暴露宿主能力状态 | `packages/plugin/src/agent-tavern/runtime.ts` |
| 工具模块 | 只接收已经解析的执行上下文；统一参数/结果预算、权限、来源和错误形态 | `packages/plugin/src/agent-tavern/tools.ts` |
| 聊天 projector | 按 DSH event cursor 幂等写 JSONL，保存 checkpoint，并报告待修复状态 | `packages/plugin/src/agent-tavern/projector.ts` |
| 宿主 adapter | 集中封装 rc.6 的 preset、prompt、tool、event 和 idle 探测；版本差异不得散落到工具实现 | `packages/plugin/src/agent-tavern/dsh-adapter.ts` |
| ST 兼容路径 | 保留当前 pipeline 与 `/generate`；镜像 turn helper 只允许由 `st` binding 调用 | `packages/plugin/src/index.ts`，后续再按需要拆分 |

这些模块的 interface 同时作为测试面。文件存储和 DSH runtime 分别使用临时目录 adapter 与
最小 fake adapter 验证，不把内部索引器、文件布局或事件遍历细节暴露给调用方。

## 4. 实施里程碑

### M0 宿主契约与失败关闭

| # | 改动 | 验收 |
|---|---|---|
| 0.1 | 锁定 rc.6 实际注入名和生命周期：preset mount 必须发生在 agent publish 前；核对 agent-scoped `systemPrompt`、原生 tool pipeline、`agent/pre-step`、event append/replay 和 idle 状态 | 写成 `dsh-adapter` 的最小 interface，并有 fake adapter 契约测试 |
| 0.2 | 验证插件能按 session 选择 `agent-tavern` preset，重启后能从 preset id 与 binding 恢复 | 同一 session 重启前后 kernel、工具集合和 preset id 一致 |
| 0.3 | 验证 `user/message`、`assistant/message`、tool、turn/step、取消和错误事件的稳定字段与排序；确认 projector 可取得单调 cursor | 使用真实 rc.6 的 mount/integration 脚本保存事件样本，测试不依赖对象引用 |
| 0.4 | 验证新聊天 greeting/历史导入的宿主表达。优先写入带来源的 durable transcript-import 事件；若 rc.6 不允许合法的 imported assistant event，则 greeting 仅留在 JSONL/read model，并由 history 工具取回，不伪造模型 turn | 方案必须可重放且不会被统计为一次模型生成 |
| 0.5 | 引入 `AgentTavernCapabilities`，bootstrap 返回 `native.available`、`managed.available` 和不可用原因 | rc.6 默认 native 可用、managed 不可用；能力不满足时新建入口失败关闭 |
| 0.6 | 验证 session event log 的持久性。若不能可靠持久化，先实现同步 write-through/checkpoint，再允许 AgentTavern 成为默认架构 | 重启恢复测试证明不会丢消息或重复投影 |

M0 是硬门槛。任何契约与审计文档不一致时，先更新审计/ADR 和本计划，再进入产品代码；不在
业务模块里通过版本字符串猜测行为。

### M1 状态、迁移与持久存储

| # | 改动 | 文件与细节 |
|---|---|---|
| 1.1 | binding 改为判别联合 | 增加 `TavernArchitecture`、`TavernContextMode`；`st` 不携带 `contextMode`，`agent-tavern` 必须携带 |
| 1.2 | 增加新会话默认值 | `TavernState.defaultArchitecture = 'agent-tavern'`、`defaultContextMode = 'dsh-native'` |
| 1.3 | 集中 normalizer | `readState()` 对 legacy binding 补 `architecture: 'st'`；显式 AgentTavern binding 缺 mode 时补 native；非法值失败关闭或回落到兼容安全值并记录诊断 |
| 1.4 | 更新 binding 写入口 | command bridge、`POST binding`、rename/delete/prune 都保留 architecture/context mode；群聊拒绝 AgentTavern |
| 1.5 | 角色短摘要 | 存在 `card.data.extensions.agentTavern.identitySummary`，服务端限制长度；缺失时只派生名称、昵称和极短描述，不修改原卡 |
| 1.6 | `MemoryStore` | 文件存储、稳定 id、scope、kind、source、importance/confidence、TTL、revision、软删除和确定性词法检索；所有写入原子化 |
| 1.7 | `VariableStore` | 与 ST `scriptGlobals` 分离；支持受限 JSON 值、scope、revision、单值/总量限制和同 revision 原子 patch |
| 1.8 | 存储测试 | 覆盖 legacy 迁移、无静默切换、并发 CAS、跨 scope 隔离、TTL/软删除、排序稳定、路径穿越和损坏文件诊断 |

建议文件布局由 store 实现私有管理：`memories/` 保存记录和审计，`variables/` 按作用域保存快照，
projector checkpoint 放 `projections/`。调用方只能通过 store interface 访问，不能自行拼接路径。

### M2 原生 preset、kernel 与工具

| # | 改动 | 验收 |
|---|---|---|
| 2.1 | 注册并挂载 `agent-tavern` preset | 只对 AgentTavern binding 生效；普通 DSH 和 ST session 的 prompt/tool 集合不变 |
| 2.2 | kernel contract | 仅包含身份摘要、用户/persona 摘要、session/architecture 标识、工具/作用域规则和不信任检索指令规则；不含路径、密钥、完整卡、完整世界书或完整历史 |
| 2.3 | 只读 Tavern 工具 | 实现 `tavern_character_get`、`tavern_scene_get`、`tavern_lore_search`、`tavern_history_search`；每个请求和返回都有硬上限、来源、版本、`truncated`、`sourceCount` |
| 2.4 | 记忆工具 | 实现 `memory_search/read/write/update/forget`；默认只允许当前 chat/character/agent，global 写入和跨角色操作拒绝 |
| 2.5 | 变量工具 | 实现 `variable_get/set/patch/delete/list`；scope 来自真实 binding，参数中不暴露任意 sessionId/scopeId |
| 2.6 | 原生回流 | tool result 和 `additionalContexts` 只经 DSH tool pipeline 进入下一 step；插件不创建嵌套 AgentLoop |
| 2.7 | 限流与错误 | 统一调用次数、输入/输出 token、超时和单 turn 写入上限；空搜索返回空结果，CAS 冲突返回可恢复的结构化错误 |

工具注册前先解析 `agent.id -> binding -> character/chat`，再创建不可变的执行上下文。权限检查放在
store/tool 的公共 seam 内，不能只靠 prompt 约束，也不能相信模型提供的角色名或聊天 id。

### M3 原生 turn 与 JSONL 投影闭环

| # | 改动 | 验收 |
|---|---|---|
| 3.1 | AgentTavern 激活 | 新建单角色聊天按默认架构创建 binding 并挂 preset；不调用 `occupyHostSession()`，后续用户发送直接进入原生 AgentLoop |
| 3.2 | 路由隔离 | `/generate`、regenerate、swipe 和 STscript 生成动作校验 binding 必须为 `st`；不匹配返回可解释的 `409` |
| 3.3 | projector | 订阅原生 user/assistant 终态事件，按稳定 event cursor 写 JSONL；tool/chunk/reasoning 不伪装成聊天消息 |
| 3.4 | 幂等和并发 | JSONL `extra` 记录 session/event/turn/step 来源；checkpoint 与 chat revision 一起推进，重复事件、重启和跨标签页冲突不会重复追加 |
| 3.5 | 失败修复 | 投影失败保存 `pending/error/lastCursor`，提供查询与重放入口；重放只补缺失事件，不改写已确认消息 |
| 3.6 | ST 镜像收口 | `beginTavernSessionTurn()`、`recordTavernSessionChunk()` 等 helper 保留给 ST；静态 gate 和运行时断言阻止 AgentTavern 调用 |
| 3.7 | 原生语义回归 | 覆盖正常完成、tool 多 step、Stop、provider error、CAS 冲突、模型 route 切换和进程重启 |

聊天投影以 assistant 终态事件为提交点，不把流式 chunk 持久化到 JSONL。取消时保留已经成功完成的
memory/variable 工具写入及其审计事件；没有终态 assistant message 时不写半条聊天消息。

### M4 客户端双架构与管理面板

| # | 改动 | 文件与细节 |
|---|---|---|
| 4.1 | 新建流程 | 单角色创建时发送默认/显式 architecture；群聊固定 `st`；打开历史 binding 时使用 normalizer 后的架构 |
| 4.2 | composer 分流 | `selectTavernComposer()` 只匹配 `st`；AgentTavern 使用原生 composer、模型选择、Stop 和错误表面 |
| 4.3 | view 分流 | ST 继续使用 Tavern JSONL tab；AgentTavern 打开原生 conversation view，不再自动点击 Tavern tab；projector 状态只作为管理信息 |
| 4.4 | 会话标识 | header 和聊天列表显示 `AgentTavern`/`ST`；仅 ST 显示 swipe/regenerate/model seat，避免无效动作 |
| 4.5 | 默认架构设置 | 管理面板提供 `AgentTavern`/`ST` segmented control，只影响新会话，并显示群聊限制 |
| 4.6 | context mode | AgentTavern 会话显示“DSH 上下文 / Agent 记忆”；MVP 中 managed 选项禁用并显示 capabilities 返回的原因 |
| 4.7 | 架构切换 | 不在原 session 原地改 architecture；实现“分叉到另一架构”，保留 `bookmark_link` 和 origin transcript 引用 |
| 4.8 | 记忆与变量审计 | 面板支持按 chat/character 查看来源、revision、过期/软删除状态和 projector 错误；危险写入仍由服务端权限决定 |
| 4.9 | locale/gates | zh/en 同步增加所有文案；client VM gate 覆盖 legacy ST、新 AgentTavern、群聊 ST 和 managed unavailable 四条选择路径 |

### M5 发布门禁与回归

| # | 门禁 | 通过条件 |
|---|---|---|
| 5.1 | 类型与单测 | `tsc -b --pretty false`、全部 Vitest 通过；新增 store、tools、projector 和 binding migration 测试 |
| 5.2 | bundle/gates | `pnpm run build:plugin` 与 gates 通过；server gate 检查 preset/capabilities/routes，client gate 检查双架构 slot 选择 |
| 5.3 | 单循环静态门禁 | AgentTavern 目录不引用 `llm.stream`、`runGeneration` 或 ST pipeline；`/generate` 只接受 ST binding |
| 5.4 | rc.6 真机 happy path | 新建 AgentTavern -> 原生发送 -> 至少一次工具调用 -> assistant 完成 -> JSONL 投影 -> 重启后恢复，全链路只出现一套 turn/step/tool/message |
| 5.5 | ST 回归 | 旧 binding 的生成、Stop、edit、swipe、regenerate、branch、STscript、Text Completion 和群聊行为不变 |
| 5.6 | 安全回归 | 伪造 session/scope、global 写入、超限结果、路径穿越、CAS 冲突和未授权 forget 均被拒绝且不泄露内部路径 |
| 5.7 | 发布开关 | schema 目标默认值始终是 `agent-tavern`；若部署环境尚未通过 M0-M4，可用不持久化的 rollout flag 临时让新会话落到 `st`，全绿后移除该覆盖 |

### M6 `agent-managed`（受宿主阻塞）

以下任务不进入 MVP 的完成定义：

1. DSH 提供正式 `agent/context` waterfall，强制合并 required seq、保持 tool call/result 原子单元，
   并记录带 surface generation 的 `request/projection` 事件。
2. DSH basic compaction 改为按 effective projection 测压并在 replacement 后重新投影，或提供
   profile/session-scoped suppression；只满足其中一个并通过恢复测试后才算 capability available。
3. 在 `packages/plugin/src/agent-tavern/context-projector.ts` 实现纯选择模块：保留 kernel、当前
   step、近期消息和未闭合 tool 单元，再按相关度、重要性、新鲜度和来源可信度分配预算。
4. mode 切换只允许 agent idle，binding 更新与 `agent-tavern/context-mode` event 同时成功；失败时
   保持原 mode。managed -> native 只停止后续 projection，不声称恢复已发生的 surface replacement。
5. 增加 request reconstruction、surface generation race、projection 超时、overflow recovery 和
   native/managed A/B 指标测试。Fabric 只用于已安装 loader hook 的 source checkout 验证，
   target 未绑定即拒绝 managed，不能进入默认生产依赖。

### M7 后续范围

- 群聊 AgentTavern：等待宿主提供 `assistant/message.actorId` 或等价元数据，再实现原生 speaker
  selection；在此之前始终使用 ST。
- memory curator：独立 preset 或用户显式命令，摘要默认低置信度且需确认；不做后台自动总结。
- embedding adapter：只有词法检索指标证明不足后再增加，不能成为第一版运行时前置依赖。
- 旧会话批量迁移：只有 AgentTavern 的导出、分支、失败恢复和群聊均通过验收后再设计。

## 5. 依赖与交付顺序

```text
M0 宿主契约
  -> M1 binding / store
     -> M2 preset / kernel / tools
        -> M3 native event -> JSONL projector
           -> M4 client 双架构
              -> M5 发布门禁

M6 agent-managed 依赖 DSH agent/context + compaction 协同，不阻塞 M0-M5。
M7 群聊/curator/embedding 不属于首个 AgentTavern 发布。
```

每个里程碑以独立、可回滚提交交付。M1-M4 每步至少运行相关 Vitest、plugin build 和对应 gate；
M5 再运行完整 `pnpm run check` 与 rc.6 真机矩阵。任何阶段失败都保持 legacy ST binding 可用，
且不通过修改已有 binding 的方式回滚。

## 6. 首批测试清单

1. 旧 state 中 `{ character, chatId }` 读取为 ST，写回后语义不变。
2. 新单角色会话默认 `{ architecture: 'agent-tavern', contextMode: 'dsh-native' }`；新群聊为 ST。
3. AgentTavern kernel 和工具不会出现在普通 DSH/ST agent 上。
4. 模型伪造 chatId、character 或 scopeId 不能读取/修改另一会话的数据。
5. memory/variable 同 revision 并发写只有一个成功；失败方得到当前 revision。
6. 同一原生 assistant event 投影两次，JSONL 只出现一条消息；重启后从 checkpoint 继续。
7. Stop/provider error 不产生半条 assistant JSONL，已提交工具写入仍可审计。
8. AgentTavern 请求不会命中 `/generate`，ST 请求仍只产生现有一套镜像事件。
9. provider/model route 改变后，native 模式不读取 Tavern 缓存的 context window。
10. rc.6 缺少 `agent/context` 时，客户端与服务端都拒绝 managed，binding 保持 native。

## 7. 完成定义

M0-M5 全部通过后，AgentTavern MVP 才算完成：新单角色会话默认使用原生 AgentLoop；一次 turn
只有一套原生执行事件；原生消息可稳定投影、重放和导出；记忆/变量/资产工具具备作用域与审计；
所有历史 ST 会话和群聊保持原行为；`agent-managed` 在宿主能力不足时明确不可用。
