# B-3 记忆维护 Agent：chat 作用域记忆的自动纠错/合并/去错 run

日期：2026-10-11。来源：docs/exploration/2026-10-11-jsr-lwb-reference.md §3.1 A6 /
建议表 B-3。参考语义：LittleWhiteBox `modules/story-summary/docs/memory-maintenance-target-design.md`
（262 行规格书，Apache-2.0 只取机制设计不抄代码）。

## 开工前八项表（CONTEXT.md 纪律；规则晚于本文落地，补记于 2026-10-11 审查修复）

| 项 | 答案 |
|---|---|
| 所有者 | run 编排与私有工具面 `packages/plugin/src/memory-maintenance.ts`；状态 sidecar `packages/tavern-store/src/memory-maintenance.ts`；HTTP 面 index.ts 两路由；面板行 client/main.js「记忆检索」分区 |
| 唯一事实来源 | 记录本体 = MemoryStore chat 作用域（revision CAS）；维护进度 = `<tavern>/memory-maintenance/<character>/<chatId>.json`（收据 + lastRun） |
| 持久态 | 收据 `{runId, baseFloor, headFloor, floorSig, recordSnapshots}` 与 lastRun——可重建的进度元数据（损坏按空处理，最坏全楼面重维护一遍） |
| 临时态 | 进程内 run 注册表（同 scope 409 单飞判据）与 run 开场的冻结证据快照，重启即失；重启发现 running 无在跑注册就地改标 error/interrupted 落盘 |
| 外部依赖 | 宿主 `ctx.llm.stream`（部署默认模型、不带 purpose——封闭枚举不私加）；B-2 embed 三件套（编辑成功即重嵌，失败不阻塞走懒回填） |
| 注册入口 | `POST/GET /api/dsh-tavern/memory/maintenance` + 面板「记忆检索」分区「记忆维护」行（1.5s 轮询）；工具面是 run 私有不进 ctx.tools |
| 删除路径 | 删 plugin/tavern-store 两个 memory-maintenance.ts + index.ts 路由 + 面板行 + memory-maintenance.spec.ts + 数据目录 `<tavern>/memory-maintenance/`；MemoryStore.list 公开方法若无其他消费者一并删 |
| 兼容对象 | 聊天原文零写路径（run 前后快照逐字节不变，测试钉死）；agent.ts 模型工具面零改动；memory-audit jsonl 审计照旧；收据让位 + 128 封顶只丢「已完成」标记不丢数据 |

## 1. 定位

服务端维护 run（compaction curator 同族的宿主 `ctx.llm.stream` 辅助调用），**不是 Mod、
不是模型工具面**：工具循环是 run 内部私有的（工具 schema 只进维护请求的 `tools` 参数，
不注册进 `ctx.tools`），维护 LLM 是"记忆管理员"角色。维护对象是 **chat 作用域**记忆
（`memory_search`/`memory_write` 的主战场，跨批次重复漂移的实际发生地）。改动文件：

- `packages/plugin/src/memory-maintenance.ts`——run 编排 + 工具面 + 退役判定。
- `packages/tavern-store/src/memory-maintenance.ts`——维护状态 sidecar（收据 + lastRun）。
- `packages/tavern-store/src/memory.ts`——新增公开 `MemoryStore.list(scope, scopeId)`
  （`search` 有 MAX_RESULTS=50 封顶且按相关性排序，维护需要确定性顺序的完整清单）。
- `packages/plugin/src/index.ts`——`POST/GET /api/dsh-tavern/memory/maintenance` 路由。
- `packages/plugin/client/main.js`——「记忆检索」分区内新增「记忆维护」行。

## 2. 触发与入口

v1 **手动触发**：面板「记忆检索」分区内「记忆维护」行（角色/聊天选择 + 按钮 + 上次
运行状态 + 待维护范围提示）。`POST memory/maintenance {character, chatId}` →
`{ok, runId}`（wait:false 风格，run 在本进程后台执行，浏览器断开不中断）；
`GET memory/maintenance?character&chatId` 轮询 `{status, startedAt, finishedAt?,
summary, pending, receipts}`（客户端 1.5s 轮询，与自更新安装进度同款策略）。同 scope
同时只允许一个 run（重复触发 409 `MAINTENANCE_RUNNING`）。

**自动触发留 v2**（总结/嵌入完成后的自动入口）：v1 先用手动入口验证维护质量与成本
曲线；自动化的挂钩点（turn 结束后的 pending 检查）在 AgentTavern 隔离纪律下需要额外的
触发面设计，不在本批次。

## 3. 工具面（run 私有，五个）

| 工具 | 契约 |
|---|---|
| `ReadMemory` | 分页读当前 chat scope 记忆：32 条/页、16k 字符/页限（单条超页预算时整条返回不截断），可选 kind/query 过滤（词法语义与 agent 工具面同款：≤3 token 严格 AND，>3 token 命中 ≥40%）；返回 id/content/tags/kind/revision/importance/confidence/source + `more` 游标（页码偏移，createdAt→id 稳定排序） |
| `SearchSource` | 对聊天原文做词法检索（复用 tokenizeQuery + 分级匹配 + 摘录），返回命中楼层号与 400 字摘录，上限 20 条 |
| `ReadSource` | 按楼层范围读原文：≤400 楼/次、24k 字符/次界 bound，**只读**——维护模块没有任何聊天写路径 |
| `EditMemory` | **整组原子提交**：`update{id, expectedRevision, content?, tags?, importance?, confidence?, reason?('merge'\|'correct')}` / `delete{id, expectedRevision}` / `create{content, kind, tags?, ...}`。预检全部冲突（存在性 + revision）→ 任一冲突**整组拒绝零写入**（错误含冲突项定位）；应用中途异常则**回滚已应用项**（restore 走当前 revision CAS）。新建记录 source 标 `{kind:'maintenance', runId, character, chatId}`；更新保留原记录 source（出处不因维护丢失，维护归属由 revision 变更 + 收据快照证明）。编辑成功的记录立即经 B-2 路径重嵌（`embedMemoryRecord`，失败不阻塞——向量 stale 由既有懒回填兜底）；删除同步清向量缓存 |
| `CompleteMaintenance` | 声明完成范围 `{baseFloor, headFloor}`（消息下标，0 起含端点）+ 可选 `abandonEdits`（放弃声明的未决项 id）。**有 EditMemory 失败未消化则拒绝记完成**：失败组把全部条目标进未决集，成功重交整组消化同 id 条目，abandonEdits 显式放弃；未决集非空时返回错误与清单 |

## 4. 完成收据与退役

每 scope 状态文件 `<tavern>/memory-maintenance/<character>/<chatId>.json`
（`{receipts, lastRun}`；损坏按空处理——这是可重建的进度元数据，最坏代价是全楼面
重新维护一遍，不抛错阻断）。收据 = `{runId, baseFloor, headFloor, at, floorSig,
recordSnapshots}`：

- **floorSig**：完成时 `[baseFloor, headFloor]` 内消息 (name, is_user, is_system, mes)
  序列的 SHA-256。ST 聊天消息没有稳定 id，dsh 化用**区间内容指纹**：范围内任何编辑/
  删除（或区间越界）⇒ 指纹不符 ⇒ 退役；尾部追加不扰动既有区间指纹。
- **recordSnapshots**：完成时 chat 作用域全部活跃记录的 `{id: revision}`。任一记录
  revision 不符或消失 ⇒ 退役。
- **待维护范围** = `[0, 楼数-1]` − 有效收据并集（新楼面天然无收据）。退役判定在
  run 开始时执行并**持久化**（receipts 就地清理，summary 报告退役数与原因）；
  GET 状态读取时只现算不落盘。
- 收据追加时被新区间完全包含的旧收据让位、总量封顶 128（最老先淘汰，淘汰只是丢了
  "已完成"标记）。

## 5. run 纪律

- **预算**：单 run 最多 24 次 LLM 请求（**失败也计数**；达到上限保留成果、未声明范围
  留待下轮，如实收尾）。开场材料（记忆清单摘要 + 待维护范围 + 维护指令）超 100k 字符
  则**预算减半（12）**并截断清单。另有对话总字符护栏 600k（超过按预算纪律收尾——v1
  没有 LWB 的独立 summaryAdapter 压缩通道，见 §7 差异表）。
- **模型**：`ctx.llm.stream` 走部署默认模型（`agentDefaultModel.currentSelection()`），
  v1 不加配置面；`GenerateOptions.purpose` 是宿主封闭枚举
  （`'compaction'|'session-title'`），**不带 purpose**（测试钉住）。
- **证据边界**：run 开始时捕获聊天快照，SearchSource/ReadSource/完成指纹只看这份
  冻结快照——run 期间的原文追加不进入本次证据（下轮 run 由楼面指纹差异自然覆盖）。
- **生命周期**：run 开始即把 lastRun 落成 running；进程重启后注册表为空，状态读取发现
  "running 但无在跑注册"就地改标 `error/interrupted` 并落盘，不假装完成。
- **收尾形态**（lastRun.outcome + summary.outcome，GET 的 status 仍是三态）：
  `completed`（模型文字收尾或零范围空转）→ status done；`budget-exhausted`（24 次用尽
  或对话护栏）→ status done + summary.outcome 细分（纪律内收尾不是 error）；
  `error`（流错误/截断/聊天缺失/crash 兜底）→ status error；`interrupted`（重启扫描）
  → status error。
- **维护指令要点**（system + 开场 user 消息）：跨批次同一事件合并（保留较早记录身份、
  补齐来源楼层、删除重复占位）、纠正与原文冲突的陈述、删除被证伪记忆；**改写必须有
  原文依据**（先 SearchSource/ReadSource 查证），证据不足保留原记录并汇报未解决；
  正常记录可以不改，不为工作量制造修改。

## 6. E1 场景（规格书 §3.1 例 E1 的 dsh 化）

夹具：同一剧情事件（林小雨的赌债）横跨第 17-20 楼（批次一：对峙+限期）与第 21-23 楼
（批次二：还清+撕欠条）；记忆面有批次一的 A、批次二的重复占位 B、无关正常记录 C、
与原文冲突的期限陈述 D。mock 维护 LLM 走完
ReadMemory → ReadSource(15-23) → EditMemory(A 合并补齐 17-23 + 删 B + 修正 D) →
CompleteMaintenance(0-23) → 文字收尾。断言（memory-maintenance.spec.ts 全绿）：

- A 身份保留（同 id）、内容补齐来源至 17-23 楼、revision 更新、source 不变；
- B 软删、C 零触碰；收据落盘（floorSig 与区间指纹一致）；再次 run 待维护为空且零
  LLM 调用；追加 3 楼后待维护恰好 `[24,26]`；编辑后向量按新内容重嵌（digest 一致）。

## 7. 与 LWB 规格的差异表

| LWB（262 行规格书） | dsh v1 | 理由 |
|---|---|---|
| 总结提交后自动触发（§5.1） | 手动触发（面板维护行） | 先验证维护质量与成本；dsh 无"总结批次提交"事件可挂（B-2 是 pull-based 工具模型） |
| 维护 L0 锚点 + L2 大总结双层 | 只维护 chat 作用域记忆记录 | dsh 记忆栈只有 MemoryStore 单层；character/agent/global scope 记录不在本 run 范围（chat 是漂移主场） |
| 198k 输入上限 + 独立 summaryAdapter 压缩（§5.4） | 24 次请求预算 + 100k 开场 + 600k 对话护栏，无压缩通道 | 单 run 规模小得多；宿主无压缩 seam；护栏触顶即如实收尾，下轮续 |
| 每 run 256 次请求 | 24 次 | 维护对象是单 chat 记忆面，24 轮工具循环已覆盖百级记录；成本可控优先 |
| 楼层一基编号 + 消息 id/revision 指纹 | 0 起消息下标 + 区间内容指纹 | ST 聊天格式无消息 id；区间内容指纹是等价的退役语义（编辑/删除必退役，追加不扰动） |
| 记录按批次归属选材（§5.6） | 无批次归属，全量清单入场 + ReadMemory 翻页 | dsh 记录没有批次元数据；清单入场有 100k 上界 |
| 维护归属区分"Agent 自身修改不当成外部变更"（§5.5） | revision 不符即退役（不区分写者） | dsh 记录无法归因写者；更保守（多维护一遍）而非漏维护；run 自身产出的收据快照是 post-edit 的，不会被自己退役 |
| 修改差量/撤销链/锚点退役标记（§6.3/§7.2） | 只有收据 + lastRun（无 undo 库） | 撤销链是独立大批次（B-6）；MemoryStore 的 memory-audit jsonl 已有写入审计 |
| 分页"记录变更返回冲突须从起点重读"（§5.6） | 页码偏移分页（createdAt→id 稳定序） | 维护编辑只改 revision/updatedAt 不改排序键；同 run 内删除会平移页——模型重读即可，不做冲突游标 |
| 运行控制可停止、pending 队列合并触发（§4.1/§5.3） | 无停止按钮、无队列 | 单飞 + 预算 24 次的 run 天然有界（分钟级）；停止面留 v2 |
| 空范围不消耗请求 | 同（零 LLM 调用直接 completed） | 一致 |

## 8. 边界与红线

- 维护**永不改写聊天原文**（模块无任何聊天写路径；测试钉住 run 前后快照 revision
  与消息逐字节不变）。
- 不碰模型工具面：`packages/plugin/src/agent-tavern/agent.ts` 的记忆工具定义零改动；
  维护走 MemoryStore 直连（revision CAS 与 `memory_update`/`memory_forget` 同一契约）。
- EditMemory 的原子性边界：进程内经 MemoryStore 的 mutationTail 串行；跨 bundle
  （agent.mjs 工具与 index.mjs 维护同时写）靠 revision CAS——预检捕获常态冲突，
  应用中段的竞态由回滚兜底（restore 失败时记录已不一致的极端情形下，收据快照退役
  机制会让该范围下轮重扫，不产生静默漂移）。
- mod-api.md 未动（维护不是 Mod 面）；README 测试基线数字未动。
