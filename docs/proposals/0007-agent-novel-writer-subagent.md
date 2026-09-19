# 提案 0007：AgentNovel 写手子代理与有界写作上下文

> 状态：已实施（W0–W2，2026-09-18；W3 默认切换待 A/B 实测）。设计日期：2026-09-18。实施记录见 §14。前置提案：[0005](0005-agent-novel-architecture.md)、[0006](0006-usage-anchored-compaction-pressure.md)。本文是写作执行上下文与 token 成本架构的补充设计说明：不推翻 0005 的存储、调度、认领与提交契约，只改变 `write-unit` 工作的**执行位置**与**上下文组装方式**。直接动因：AgentNovel 真机 E2E 缓存命中率超过 90%，但输入 token 仍占用量大头；0006 记录的 517k prompt 用量溢出事件证明窗口压力真实存在，不是统计错觉。

## 1. 目标与设计结论

Working backwards from 三个事实目标：输入 token 体积不再随进度无界膨胀；写作上下文不再逼近 provider 窗口上限（0006 的 `session-b45f1229` 事件）；正文连续性质量不劣于现状。由此得到的核心选择：

1. **执行位置迁移**：`write-unit` 的模型执行从主会话 turn 迁入一次性写手子代理；主会话只保留规划（outline-create/revise）、指令处理、章节完成检查与全书完成检查。主代理上下文因此只累积 brief、委托回执与规划工作——天然有界。
2. **粒度是写作单元，不是章节**：沿 0005 §6.3 的 unit（场景或片段，可小于一章），与 `nextWork` 调度粒度一致。章节完成检查与 finish 是廉价结构校验，留在主代理。
3. **两级形态递进**：W1 弱形态（写手子代理纯产稿，主代理校验后代提交，零宿主契约变更，完全复刻 deduce 模式）；W2 强形态（写手子代理持单单元委托自提交，主代理不接触正文）。`writerMode: 'inline' | 'subagent'` 逐小说配置，默认 `inline`，W3 验收后切默认。
4. **连续性程序化**：写手不继承父会话历史（spawn 语义），所需前文由纯函数从 store 组装的**写手包**提供；包不完整时明确失败，不静默降质。
5. **成本承诺的诚实边界**：本提案承诺的是**原始输入量与窗口占用有界线性**；缓存折扣后的账单倍数取决于 provider 计价与缓存行为，以 W0 打点与 W3 同题 A/B 实测为准（§2），不预先宣称倍数。
6. **委托凭证收紧**：W2 的执行令牌保存在插件进程内委托注册表，不经模型可见文本传递——比现状（claim 工具结果把 bearer token 直接给模型）攻击面更小。

```
driver 调度（不变）
  -> write-unit notice（措辞按 writerMode 分支）
  -> 主代理：novel_unit_claim（既有契约）
  -> W1: novel_writer_draft -> 写手 spawn(allow:[]) -> 候选稿 -> 主代理 novel_body_commit
     W2: novel_writer_delegate -> 写手 spawn(allow: 只读+commit) -> 写手自提交 -> 回执校验
  -> 父 turn 结束 -> driver 记账（不变）-> 下一单元
```

## 2. 背景与量化模型

### 2.1 输入 token 现在堆在哪（代码事实）

- 整部小说运行在**同一个宿主会话**：driver 对绑定的 agent 逐单元发 followup notice（`packages/plugin/src/agent-novel/driver.ts` `deliverFollowup`/`buildNoticeMessage`），turn/end 后调度下一单元。会话历史只进不出，靠宿主 compaction 兜底。
- 每个单元向会话沉淀：brief notice（紧凑，非问题主体）；`novel_outline_read` 全量 JSON（story + 全部 characters + 10 章窗口 + 当前章 scenes + 全部伏笔 + assets，单次数千 token，kernel 的 research-before-writing 会反复触发）；角色卡、lore 检索、`novel_body_read` 近期正文、`novel_facts_read`；正文本身（assistant 输出与 commit 参数各经过一次）；deduce positions。这些全部留在历史，**每个后续 turn 作为输入重发**。
- 增长模型：单 turn 输入 ≈ 已积累上下文，compaction 封顶前随单元数线性增长，全书累计输入对单元数是平方级；封顶后是 N × 封顶值的线性重发。90% 缓存命中只改变重发部分的单价，不改变量。

### 2.2 raw 体积 ≠ 账单（决策分水岭）

| 痛点 | 现状 | 写手子代理的效果 |
|---|---|---|
| 原始输入量 / 窗口上限 | 每 turn 重发全量历史（E2E 实测可至数百 k） | 每单元一个有界新上下文（写手包 + 自助检索，目标 ≤ 25k） |
| 缓存折扣后账单 | ≈ (历史 × p_cache) + (新增 × p_input) | 写手 token 几乎全为新 token（p_input），但总量有界 |

代入示例（封顶 100k、每单元新增 10k）：若 p_cache = 0.1 × p_input，现状每单元账单当量 ≈ 9k + 10k = 19k，子代理 ≈ 20k 全价——**大体打平**；若缓存折扣只有五折、缓存 TTL 过期导致冷启（长正文生成耗时分钟级，下一单元可能出缓存窗）、或 compaction 频繁（每次压缩 = 全量重读 + 摘要输出，压缩后首 turn 大段未命中），现状每单元 ≈ 60k，子代理 ≈ 25k——**2~4× 实质胜出**，且窗口占用与 compaction 依赖同时消失。

结论：结构上"有界上下文"方向正确（体积、窗口、压缩质量三条线都受益），账单倍数必须实测。因此 W0 先打点、W3 才切默认，缓存命中率作为过程指标允许下降——**优化账单与质量，不优化命中率虚荣指标**。

### 2.3 与 0006 的关系

0006 让压缩闸门改看真实 usage，治的是"该压不压"；本提案治的是"根本不必长这么大"。写手子代理使写作上下文永不逼近压力阈值；主会话只承载规划工作，体量小、压缩罕见。两者叠加而非互替。

## 3. 架构总览

改动集中在执行层与上下文组装层；`NovelStore` 的提交协议、认领守卫、意图持久化、driver 调度决策全部不变。

| 组件 | 职责变化 |
|---|---|
| 主代理（作者） | write-unit 工作从"自己调研+写+提交"变为"认领 + 委托 + 验回执"；规划/修订/完成检查职责不变 |
| 写手子代理 | 一次性 spawn（deduce 同款 seam）；W1 纯产稿无工具，W2 持单单元委托自助检索并自提交 |
| 写手包 | 新增纯函数渲染；从 snapshot 与正文投影组装连续性材料，不经模型调用 |
| 委托注册表 | 新增进程内安全映射：子代理身份 → {novelId, unitId, executionToken}；W2 专属 |
| driver | 调度逻辑零改动；write-unit notice 的指令措辞按 writerMode 分支 |
| NovelStore | 新增 writerRuns 计数与可选 usage 采样记录；既有写入路径不动 |

主会话每单元净增：brief + 委托回执摘要 ≈ 1~2k（W2）；W1 另有候选稿一次进出 ≈ +正文体积。全书主会话上下文从"随正文平方膨胀"变为"随规划工作缓慢线性"，且规划工作天然适合 compaction 摘要（有版本化大纲作锚）。

## 4. 写手包（writer pack）契约

### 4.1 字段与来源

| 块 | 内容 | 来源 | 上限 |
|---|---|---|---|
| 写手协议 | 固定文本：纯正文纪律、来源引用规则、输出格式（W1）/ 工具使用守则（W2） | 常量 | 固定字节 |
| 故事页 | premise/theme/mainConflict/endingDirection/taboos + 文风要点 | `outline.story` | 单字段 400 字符 |
| 章节块 | 当前章 purpose/entryCondition/exitCondition/order | `outline.chapters[current]` | 单字段 300 |
| 场景块 | goal/participants/timeLocation/causality/conflict/expectedChange/continuationAnchor | `outline.scenes[sceneId]`（driver 已选定的场景） | 单字段 300 |
| 角色页 | 参与角色的 identitySummary + description/personality 摘录 | 项目资产快照（同 `novel_character_read` 解析核心） | 每角色 2k，≤ 6 角色 |
| 自动 lore | 键或内容命中场景关键词（participants/goal/timeLocation 分词）的世界书条目 | 固定世界书快照（复用 `novel_lore_search` 匹配逻辑） | ≤ 5 条 × 1200 |
| 正文尾部 | 当前章已提交正文的**原文尾部**（非摘要） | `readBody({chapterId})` 取尾 | ≤ 1600 字符 |
| 伏笔页 | 未回收伏笔（含 required 与 plantAt ≤ 当前章） | `outline.foreshadowing` | ≤ 12 条 |
| 正典页 | 参与角色的 character-state/relation 事实（带 commit 来源） | `commits[].canonChanges` 聚合 | ≤ 12 条 |
| 单元参数 | 目标字数区间、叙事阶段、剩余预算 | `unitTargetRange`/`narrativeStage`（既有纯函数） | — |

W2 写手包裁剪：角色页/自动 lore/正典页可省（写手可用只读工具自助检索），保留协议 + 故事页 + 章节块 + 场景块 + 正文尾部 + 单元参数，目标 ≤ 8k。

### 4.2 字节稳定性与前缀缓存

沿 deduce 已验证的纪律（`packages/plugin/src/agent-tavern/deduce.ts` 模块头）：请求布局 = 稳定前缀 + 单元尾段，**稳定前缀内禁止任何随单元变化的字段**：

```
[写手协议] [故事页] [角色页] [章节块]      <- 同一 outlineRevision 内字节稳定
[场景块] [正文尾部] [伏笔页] [单元参数]    <- 单元尾段，变化字段全部后置
```

字段顺序固定、空字段省略（lossless-JSON 纪律）、文本截断加省略号标记。同一章连续单元的尾部只追加不重写。provider 自动前缀缓存若命中是净赚（deduce 的轮间扩写前缀已证明可行），不命中也不影响有界性——缓存收益是 bonus，不是前提。

### 4.3 完整性校验（fail-loud）

渲染是纯函数，产出前自检，不满足即抛 `NovelWriterPackError`（新增错误类型，字段含 novelId/unitId/缺失块）：

- 当前章已有提交而正文尾部为空 → 拒绝（连续性必然断裂）。
- 场景 participants 中的角色在角色页/正典页完全无覆盖 → 拒绝。
- outlineRevision 为 null（无大纲）→ 不可能走到 write-unit，防御性拒绝。

校验失败意味着材料组装缺陷，暂停并暴露原因，不允许"缺着尾部硬写"。

## 5. 写手子代理执行契约

### 5.1 W1：纯产稿（零宿主契约变更）

- spawn 参数与 deduce 完全同构：`subagents.start('spawn', { label, prompt, parent, signal, toolFilter: { allow: [] } })`。
- prompt = 写手包（§4 全量）+ 输出格式说明：JSON `{ paragraphs, sceneCompletion, canonChanges }`（结构复用 `novel_body_commit` 的参数 schema，canon 源用 `inline`/`inline#<index>`，服务端补 commitId 的既有逻辑直接生效）。
- 新工具 `novel_writer_draft { unitId }`：校验单元处于 `claimed` 且属于当前认领 → 渲染包 → spawn → 返回候选稿或结构化失败。主代理流程：`novel_unit_claim` → `novel_writer_draft` → 审阅 → `novel_body_commit`。
- 主代理上下文净效果：调研类膨胀（全量 outline 读、lore、角色卡、facts）全部移出主会话；正文仍经过主会话一次（工具结果入、commit 参数出）。Δ_parent 从 ~10k 量级降到正文体积量级。

### 5.2 W2：委托自提交（目标形态）

- allow 列表封闭：`novel_status_read, novel_outline_read, novel_character_read, novel_lore_search, novel_body_read, novel_body_search, novel_facts_read, memory_search, memory_read, novel_body_commit`。claim **不在**列表内（由委托方完成，见 §6）；一切规划/修订/完成/写类工具不可见。
- 写手协议明确：先检索后叙述（同作者 kernel 的 research 纪律）；提交成功立即结束；解释与进度不进正文。
- 新工具 `novel_writer_delegate { unitId }`：父侧 `claimUnit` → 注册委托 → spawn → `await run.result` → **从 store 快照核验**该单元确已 `committed`（不信模型自报，同 §7.3 精神）→ 返回提交回执摘要（commitId、有效字数、场景完成声明）。未提交则返回结构化失败。
- 主代理全程不接触正文字节；主会话每单元净增 ≈ brief + 回执摘要。

### 5.3 失败与重试语义

- 写手 stopReason ≠ completed、空输出、包校验失败：作为本次委托失败上抛（同 deduce 的 failures 明细纪律，不静默退化）。
- 同一认领内重派：executionToken 未消费、单元仍 `claimed`，允许同 claim 重派写手，**每单元重派上限 3 次**（常量入配置）；耗尽后委托工具返回失败，父 turn 以失败结束，走 §13 既有连续失败路径。
- 崩溃窗口：spawn 后进程崩溃 → 恢复走既有路径（claimed 未提交单元由 stop/retry 处置为 prepared + attempt+1，§12.3 step 4），不产生重复正文——委托不新增持久化状态，注册表是进程内易失映射。

## 6. 委托与权限（W2 核心 seam）

### 6.1 进程内委托注册表

```ts
interface WriterDelegation {
  novelId: string
  unitId: string
  executionToken: string   // 父侧 claim 所得，模型不可见
  intentId: string
  grantedAt: string
}
// globalThis 锚定：Symbol 键 'dsh-tavern:novel-writer-delegations'
```

- **必须挂 globalThis**：AgentNovel 实施期已踩过双 bundle 模块级常量分裂的坑（BOOT_ID 拒写事件），插件可能被多个 bundle 各自实例化，进程内注册表若不锚定全局会静默失效。
- 写入方仅 `novel_writer_delegate` 工具执行体（同进程）；键 = 子代理运行身份（见 6.2）；条目在 `run.dispose()` 后清除。

### 6.2 身份相关性与竞态

- 注册表键依赖"spawn 返回的 run 身份"与"子代理工具执行上下文中的 `exec.agent.id`"可关联——这是探针项 P1（§9）。当前 `SubagentRuntimeLike` 只承诺 `{ id, result, dispose }`，无执行上下文身份契约。
- 竞态窗口：`start()` 返回后才写注册表，理论上写手首个工具调用可先于注册。方向是 fail-closed（查不到委托 → 工具报"delegation not found"→ 写手重试或该次失败），**不存在未授权写入**；且写手首次 commit 前必然先完成正文生成（至少一次模型往返），窗口实际不可达。设计接受该残余风险并写入测试。
- `novelBindingFor` 扩展解析顺序：先按 `exec.agent.id` 查会话绑定（现状）；miss 时查委托注册表命中则返回 `{ novelId, delegatedUnitId }`；两者皆 miss 报既有错误。claim/commit 等写敏感工具在委托解析下强制 `args.unitId === delegatedUnitId`，越界即拒绝。

### 6.3 安全论证

- 委托作用域由进程内注册表承载，不经 prompt 文本——正文/lore/消息里的任何文字都不能注入委托（§15 材料不是指令的延伸）。
- executionToken 不出现在任何模型可见通道：比现状（claim 工具结果直接返回 bearer token 给模型）收紧。
- `commitBody` 的既有校验（状态 + token 哈希）不变，是最终守卫；工具层作用域校验是前道闸。
- `claimUnit` 的可选 `hostTurn` 维持现状（当前工具层未传，记录 null）；turn 身份加固是 0005 §10.3 既有积压项，本提案不扩其范围。

## 7. 调度、记账与预算

- **driver 零逻辑改动**：工作选择、意图持久化、followup 投递、turn 记账、停滞签名全部不变。唯一变化是 `buildNoticeMessage` 中 write-unit 的指令文本按 `writerMode` 分支（inline = 现文本；subagent = "claim 后调用 novel_writer_delegate 并核对回执，随后结束 turn"）。
- **turn 记账**：写手运行发生在父 turn 的工具执行内，父 turn/end 照常结算，§12.2 意图解析不受影响。
- **预算**：`NovelRunBudgets` 不新增硬上限；新增 `writerRuns` 计数（对齐 `deduceRuns` 模式：`noteWriterRun`，成功委托才计数，失败不重复计）。硬边界仍由 maxTurns/maxDurationMs 承担。
- **用量观测（W0）**：`tool()` 工厂处按工具名累计输出字节数，随 turn 结束写入 store 的运行采样（新 `usageSamples`，审计性质非权威）；宿主若在 run result 暴露 usage 字段（探针 P4，当前 `SubagentRunLike` 无此字段）则一并记录，fail-open 仅影响观测不影响执行。面板 PATCH 沿用既有 budgets 全量编辑通道展示 writerRuns 与采样。

## 8. 配置与界面

- `NovelCreateConfig` 新增 `writerMode: 'inline' | 'subagent'`，显式传入无默认魔法（表单预设 `inline` 直至 W3）。面板 PATCH 支持运行中切换——切换只影响**下一单元**，已认领单元按认领时模式完成（与 §9.2 让路规则同构）。
- 创建表单：写作模式选择（附一句话成本说明，不承诺倍数）。面板：模式显示与切换、writerRuns、最近单元的输入构成采样（历史重发/新增工具结果/brief/正文回显四类）。
- UI 文案红线：不把"子代理写作"描述为"更便宜"，只描述为"上下文有界"；账单结论等 W3 数据。

## 9. 宿主契约验证门槛（0005 §16 增项）

| # | 待验证能力 | 必须获得的证据 | 缺失时处理 |
|---|---|---|---|
| P1 | 子代理身份相关性 | spawn 一个调用探针工具回传 `exec.agent.id` 的子代理，证明与 `run.id` 可关联 | W2 阻断，能力报告注明，仅交付 W1 |
| P2 | toolFilter allow 列表对领域工具生效 | 子代理内调用 allow 外工具被拒、allow 内工具可达 | W2 阻断 |
| P3 | 委托链路端到端 | 子代理内完成 检索→commit→越界 unitId 被拒 的完整时序 | W2 阻断 |
| P4 | run result usage 字段（可选） | 子代理 run 结果携带 token 用量 | 仅影响成本观测精度，不阻断 |
| P5 | 前缀缓存命中（可选，观测项） | 同章连续单元 spawn 的缓存命中水位 | 不阻断，用于校准预期 |

P1–P3 进入 `inspectAgentNovelCapabilities` 的 `agentNovel` 报告（区分核心/可选项与失败原因，fail-closed 不静默降级）。

## 10. 实施里程碑

| 阶段 | 交付 | 退出条件 |
|---|---|---|
| W0 用量打点 | 工具字节采样、usageSamples、面板成本视图；无行为变化 | 真机完整短篇的每 turn 输入构成四分类数字落袋；§2.2 的折扣假设被证实或证伪 |
| W1 弱形态 | 写手包纯函数 + `novel_writer_draft` + notice 大纲摘要增强（§11 落点含 inline 受益项） | inline 对照下主会话每单元净增可测下降；同题质量盲评不回退；`pnpm check` 全绿 |
| W2 强形态 | 委托注册表（globalThis）+ `novel_writer_delegate` + binding 委托解析 + P1–P3 探针 + writerMode | 探针全过；委托越权/竞态/崩溃恢复测试通过；A/B 原始输入达到目标线 |
| W3 默认切换 | writerMode 默认 `subagent`；0005 §8.1 补"写手子代理单单元写权限"修订引用 | 同题 A/B 双指标（成本 + 一致性抽检）通过，数据归档 |

A/B 目标线（W0 后可修订）：subagent 模式**原始输入总量 ≤ inline 的 40%**，窗口峰值不再逼近 provider 上限；一致性抽检（人物状态、场景承接、伏笔回收、文风）由人工盲评不劣于 inline。

## 11. 代码落点

| 文件/目录 | 拟议变更 |
|---|---|
| `packages/plugin/src/agent-novel/writer.ts`（新） | 写手包渲染纯函数、字节稳定性布局、`NovelWriterPackError`、委托注册表（globalThis 锚定）、spawn 编排 |
| `packages/plugin/src/agent-novel/agent.ts` | `novel_writer_draft`/`novel_writer_delegate` 注册；`novelBindingFor` 委托解析；`tool()` 工厂字节采样 |
| `packages/plugin/src/agent-novel/outline.ts` | `renderWorkBrief` 增加大纲摘要（story 一句话 + 本章进出条件 + 参与者简介），inline 模式同享 |
| `packages/plugin/src/agent-novel/driver.ts` | 仅 `buildNoticeMessage` 的 write-unit 指令按 writerMode 分支 |
| `packages/plugin/src/agent-novel/capabilities.ts` | P1–P3 探针条目与报告字段 |
| `packages/tavern-store/src/novel-model.ts` | `writerMode` 配置校验、`writerRuns` 计数、`usageSamples` 结构 |
| `packages/tavern-store/src/novel.ts` | `noteWriterRun`、usage 采样写入（复用既有串行写入口） |
| `packages/plugin/tests/agent-novel-writer.spec.ts`（新） | 包快照与上限、fail-loud 校验、注册表双 bundle 锚定、W1/W2 流程、越权与竞态 |
| `packages/plugin/client/main.js` | 创建表单 writerMode、面板模式切换与成本视图 |
| `docs/proposals/0005-agent-novel-architecture.md` | W3 时补 §8.1 写手子代理修订引用，本文不重复其契约 |

不新增 preset 模块与构建工件（写手协议是包内常量文本）；不改 gates 的执行隔离面。

## 12. 验收标准（可观察）

| 场景 | 可观察验收 |
|---|---|
| 成本可观测 | 每单元四分类输入构成与 writerRuns 在面板可见；与宿主真实用量（可得时）偏差有记录 |
| 同题 A/B | inline 与 subagent 各完成同一短篇；原始输入、窗口峰值、账单（若有计价数据）三列对比归档 |
| 幂等与崩溃 | delegate 后、写手提交前后、父 turn 结束前退出，恢复均只走既有 unit 恢复路径，无重复正文 |
| 委托越权 | 子代理 commit 非 delegatedUnitId 被工具层拒绝；注册表 miss 报结构化错误；dispose 后条目清除 |
| 连续性守卫 | 篡改快照制造缺尾部/缺角色场景时 `NovelWriterPackError`，正文不产出 |
| 质量抽检 | 人物一致性、场景承接、伏笔回收、文风盲评不劣于 inline；问题归因到包字段可修 |
| 模式切换 | 运行中切换只影响下一单元；已认领单元按认领时模式完成；UI 状态与存储一致 |
| 宿主隔离 | 无插件侧 LLM 调用；spawn 走既有 subagent seam；探针结果进入能力报告 |

## 13. 首版范围

交付：writerMode 配置、写手包、W1/W2 两级形态、委托注册表与探针、用量打点与面板成本视图、A/B 验收方法。

不做：章节级粗粒度写手（违反 §6.3 单元语义）、写手内嵌套 deduce（maxDepth 未探，留待后续）、基于 usage 采样的自动模式切换、追溯性成本重算、多写手并行（单元间有承接因果，并行无意义）、跨章草稿缓存。缓存命中率不作为验收指标——账单与质量才是。

## 14. 实施记录（2026-09-18）

**交付摘要**：W0/W1/W2 三个里程碑全部落地。W0（用量打点）：`packages/plugin/src/agent-novel/usage.ts`（`tool()` 工厂按工具名累计输出字节 + `drainToolOutputBytes` + P1 探针记录槽）、`packages/tavern-store/src/novel.ts` 的 `noteUsageSample`（50 条环形）与 `noteWriterRun`、driver 在 turn/end 采样落库、client `main.js` 用量采样小节。W1（弱形态）：`packages/plugin/src/agent-novel/writer.ts` 的 full 写手包渲染（fail-loud `NovelWriterPackError`）、`agent.ts` 的 `novel_writer_draft`、`outline.ts` 的 `renderWorkBrief` 大纲摘要块（inline 模式同享）、`driver.ts` 的 notice 按 `writerMode` 分支。W2（强形态）：`writer.ts` 的 globalThis（Symbol 锚定）委托注册表与 `runDelegatedWriter` 编排（重派上限 3、幂等回放）、`agent.ts` 的 `novel_writer_delegate` 与 `resolveNovelBinding` 委托解析（越权拒绝、token 注册表注入）、`capabilities.ts` 的 P1/P2/P3 探针、`index.ts` 的 POST novels subagent 创建闸门（fail-closed 400）与 GET novels/writer-probe、store 的 `writerMode` 枚举/归一化与 `patchNovelMeta`、client 的 writerMode 控件与 writerRuns 展示。测试落点：新增 `packages/plugin/tests/agent-novel-writer.spec.ts`，并扩展 novel-model/novel-store/driver/outline/tools/command 各 spec。

**偏离清单**（事实性记录，代码为准）：

1. §7 notice 措辞：subagent 模式指示"直接调用 novel_writer_delegate、勿先 novel_unit_claim"（delegate 内部认领，手动先 claim 需带 token 收养）——工具语义优先于草稿措辞。
2. §4.1 参与者简介在 renderWorkBrief 摘要中用 outline 的 name+initialState·motivation（纯快照函数无异步资产解析），写手包内仍用完整角色页（`resolveCharacterPage` 项目资产）。
3. §4.2 前缀稳定性实际粒度为"章"：前缀内的章节块随当前单元换章更新一次；角色页的 participants 并集按 `outline.scenes` 全量计算（ScenePlan 无章绑定，无法按章过滤，上限 6 个角色按 outline 声明序），因此角色页在整个 outlineRevision 内字节稳定——粒度粗于"章"，同样满足同章连续单元字节稳定的要求。
4. W2 委托的重派持久化：注册表增加 retain/release（按 unit 键，不经 runId），支持同认领重派与崩溃后由既有 stop/retry 处置。
5. delegated commit 一律用注册表 token 注入（写手不可能持有效 token）。
6. P1 探针经 novel_status_read 工具体记录 exec.agent.id 比对 run.id；P3 标注 deferred-to-e2e；POST novels 的 subagent 创建执行真实探针（fail-closed 400），另附 GET novels/writer-probe。
7. writerRuns 无硬上限（§7 原文即不加）；W1 draft 不计 writerRuns（仅成功委托计数）。
8. 用量采样仅按工具名累计、flush 时归属当前小说（审计性质，局限已在 usage.ts 注释明示）；面板成本视图只展示实测字段，不做四分类拆解。
9. §9 末段"P1–P3 进入 inspectAgentNovelCapabilities 的 agentNovel 报告"实际移入独立的 `inspectWriterSubagentCapabilities`（capabilities.ts），仅由 POST novels 的 subagent 创建闸门与 GET novels/writer-probe 触发，启动路径不执行——启动探针的成本与故障面与能力自举隔离。
10. §5.3"每单元重派上限 3 次（常量入配置）"落地为 `NovelRunBudgets.writerDispatchLimit`（可选正整数，缺省回落内置默认 3，面板沿 budgets 全量编辑通道可改）；语义是**每 claim 总派发次数（含首派）**，与"重派 3 次"字面相差一次首派。§7"NovelRunBudgets 不新增硬上限"限定为成本类预算边界（maxTurns/maxDurationMs 一类），重试参数不在此列。
11. §9 P2 的"allow 外工具被拒"证据为 observational：子代理自述 allow 外能力 unavailable 判 pass（代码自注），宿主侧拒绝证明与 P3 同批 deferred-to-e2e。
12. outline-revise 章节覆盖层重构（`materialize`/`assertChapterDropDeclarations` 等，修订 0005 §6.1 契约）为随本提案落地的捆绑修复，非 0007 范围内工作；变更记录见 0005 文档 2026-09-18 修订说明。

**2026-09-19 审查改进**（双轴代码审查后落地）：W2 trimmed 包回归 §4.1 保留清单——不再渲染伏笔页（伏笔由写手经只读工具自助检索），此前 trimmed 模式仍渲染伏笔页使 ≤8k 目标恶化；P4 fail-open 写入从"仅测试赋值"变为生产路径——writer.ts 编排在 run.result settle 后记录宿主回传 usage（仅数值字段，形状不对静默跳过），委托成功记 writerOutputChars，driver turn/end 采样 drain 并入 `NovelUsageSample`；§5.3 上限入配置（偏离 10）；`allParticipantsOf(outline)` 提取角色页/正典过滤/outline digest 三处全书并集循环，修正"当前章 participants"名不副实的注释；agent.ts 两写手工具前置序列去重（`requireWriterLaunchContext`：绑定守卫/单元存在性/runtime 探测，单元存在性先于 runtime 探测报错）；`WriterMode`/`isWriterMode` 共享枚举校验（创建校验/patch 校验/面板 cast 三处）。

**未竟事项**：W3 默认切换与同题 A/B 实测（原始输入 ≤ inline 40% 目标线、窗口峰值、账单三列归档）；真机 E2E（P1 真机关联性复核、P3 端到端检索→commit→越权拒绝时序）；§10 W1 的"同题质量盲评"。
