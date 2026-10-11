# B-5a 受控中文记忆检索评测矩阵（确定性基线与回归门槛）

日期：2026-10-11。来源：docs/exploration/2026-10-11-jsr-lwb-reference.md §4 B-5（配套先行）。
为 B-1 中文分词修复（`decisions/2026-10-11-cjk-tokenization.md`，commit 0bac59a）建立
确定性质量基线与回归门槛，并为 B-2（dense 召回）提供可复用的 A/B 语料。

## 开工前八项表（CONTEXT.md 纪律；规则晚于本文落地，补记于 2026-10-11 审查修复）

| 项 | 答案 |
|---|---|
| 所有者 | `scripts/retrieval-eval/` 四件（corpus/metrics/seed/run）+ 门槛 spec `packages/tavern-store/tests/retrieval-matrix.spec.ts`；被测检索行为本体归 MemoryStore，本矩阵纯观察不改它 |
| 唯一事实来源 | ground truth 与基线数字写死在门槛 spec（BASELINE 常量 + 语料规范哈希）；runner 控制台输出只是对账副本 |
| 持久态 | 无——评测库每次 `mkdtemp` 临时目录播种，run 结束 `rm -rf` |
| 临时态 | 进程内语料构建与指标计算（纯函数、零随机源，跨进程逐字节一致） |
| 外部依赖 | 零新增 npm 依赖；runner 走 tavern-store 构建产物 `lib/`（先 `pnpm build`）；`--dense` 需真实 embed 端点（不入 CI） |
| 注册入口 | vitest 自动收集门槛 spec；runner 手动 `node scripts/retrieval-eval/run.mjs`（无路由/面板面） |
| 删除路径 | 删 `scripts/retrieval-eval/` 整目录 + retrieval-matrix.spec.ts + 本决策文档；无运行时与数据残留 |
| 兼容对象 | MemoryStore.search 行为零接触；语料哈希冻结（改语料必先撞哈希红，逼出有意识重基线）；B-2 融合回归复用同一矩阵，仅更新 BASELINE 为融合实测值 |

## 交付物与用法

| 文件 | 角色 |
|---|---|
| `scripts/retrieval-eval/corpus.mjs` | 语料生成器（真相先行、零随机、结构自检、规范哈希） |
| `scripts/retrieval-eval/metrics.mjs` | 指标实现（recall@1/3/10、MRR、分组聚合，纯函数） |
| `scripts/retrieval-eval/seed.mjs` | 评测库播种（按 MemoryStore 磁盘契约直写固定时间戳记录） |
| `scripts/retrieval-eval/run.mjs` | runner：`node scripts/retrieval-eval/run.mjs`（走构建产物 lib/，先 `pnpm build`） |
| `packages/tavern-store/tests/retrieval-matrix.spec.ts` | 质量门槛：走 src 源码，基线数字写死，`pnpm vitest run packages/tavern-store/tests/retrieval-matrix.spec.ts` |

runner 与 spec 共用同一语料生成器与指标实现，仅检索入口不同（lib 产物 vs src 源码），
两条路径互相锚定。语料规模：**2 世界 × 65 条记录 = 130 条，66 用例**（11 维 × 每世界 3 例），
两世界记录同库加载后评测。

## 语料设计（参考 LWB gold-eval dev-matrix/controlled-cn 的思想，Apache-2.0，仅语义参考不抄实现）

- **真相先行**：每条用例先声明 ground truth（期望命中的记录 id 集合 + 维度标注），
  再渲染语料文本；判定零裁量、不依赖任何 LLM。
- **两套同构干扰世界**（modern 现代 / fantasy 奇幻）：相同维度结构、相同检索难度档、
  不同名词体系。评测时两套世界全部记录**同库**加载，天然制造跨世界词法串扰；共享干扰
  锚点：同名配角「温荔」、昵称「荔子」、数字 3-217 / 十四天 / 三个月 / 十月十七日。
- **维度清单**（11 维 = 已知 LLM 记忆失败模式，每维每世界 3 例）：直接事实 / 不确定
  信息 / 带日期事件 / 时长 / 顺序任务 / 因果三层（直接原因 vs 两跳根因链 vs 相关混淆）/
  别名与延迟别名（显别名号、延迟揭示、昵称碰撞）/ 角色弧三段（态度/技能/关系）/
  稳定特质 vs 爆发 vs 恢复 / 缺失信息（纯缺失、近邻缺失、被问拒答）/ 字段冲突
  （未决冲突、已更新旧值、同字段不同人）。
- **同世界内干扰**内建在用例中：他人同款物品颜色、近邻日期（三月九 vs 三月十九）、
  同人同学项不同时长、相关混淆（蜡烛 vs 电缆老化）、字段旧值 vs 新值等。
- **确定性**：生成器零随机源（「固定 seed」的更强形式——无可漂移的随机路径可言）；
  同版本代码跨进程逐字节一致（已验证两次运行 diff 为空）。语料规范哈希 sha256
  `3419b1ba…f1ffa7f` 冻结进门槛 spec：改语料必先撞哈希红，逼出有意识的重新基线。

## 打分项污染控制（为什么时间戳固定、先验分层）

MemoryStore.search 打分 = lexical×100 + importance×10 + confidence×5 + freshness。
评测目标是**词法检索质量**，非词法项必须受控，否则基线会随无关因素漂移：

- **时间戳**：全部记录 `createdAt = updatedAt = 2026-10-01T00:00:00.000Z`（同一毫秒）。
  freshness 项在同一次查询内对所有记录取同一值 → 排序中精确抵消；且无论评测在墙钟
  何时运行，记录间相对 freshness 恒等——**基线不随时间漂移**。若改用真实散布时间戳，
  记录间 freshness 差会随墙钟推进衰减（如 anchor 后 1 天差 0.5 分 → 一年后差 0.0005 分），
  排序贡献漂移、门槛跨月必炸。实现上播种走磁盘契约直写（seed.mjs）而非 `put()`——
  `put()` 用墙钟覆盖 updatedAt，会重新引入不确定性。副作用：本矩阵不覆盖
  「freshness 影响排序」的行为面，该面归 MemoryStore 单元测试。
- **importance/confidence**：不全统一，而是按记录角色分层（core 0.7/0.8、mid 0.6/0.7、
  low 0.45/0.55，层间最大差 3 分），并给语义上本就未确认的记录（不确定信息、字段冲突
  的猜测方）显式降 confidence 至 0.3——模拟真实写入的先验差异，保留真实排序公式，
  又确保先验差不至于主导词法分（×100）的典型差距。B-2 对比时同一套先验原样复用，
  差异只来自检索器本身。

## 指标定义

- rank：search 返回列表（limit=50，即 MemoryStore MAX_RESULTS）的 1-based 序位；
  rank>50 不可观测按 miss 计。
- recall@k（用例级）= |expected ∩ top-k| / |expected|；多期望用例（根因链、角色弧）
  在 k=1 时天然 <1，属定义而非缺陷。
- MRR（用例级）= 1 / 首条期望命中 rank，无命中记 0。
- 期望集为空的用例（纯缺失 ab1，每世界 1 条）不进均值、单列缺席例——「拒答」是答案层
  行为，词法检索层无正确输出可判。近邻缺失/被问拒答两例的期望是「佐证记录」（能证明
  信息缺失的上下文），仍进正常均值。
- 聚合：总体 + 按维度 + 按世界 + 世界×维度，均值取 4 位小数。

## 基线数字（2026-10-11，B-1 @ 0bac59a，node scripts/retrieval-eval/run.mjs）

| 分组 | n | recall@1 | recall@3 | recall@10 | MRR |
|---|---:|---:|---:|---:|---:|
| **总体**（另 2 条缺席例） | 66 | 0.6276 | 0.9036 | **0.9714** | **0.8709** |
| modern | 33 | 0.6198 | 0.9167 | 0.9792 | 0.8701 |
| fantasy | 33 | 0.6354 | 0.8906 | 0.9635 | 0.8717 |
| 直接事实 | 6 | 0.6667 | 0.6667 | **1.0000** | 0.7143 |
| 不确定信息 | 6 | 0.8333 | 1.0000 | 1.0000 | 1.0000 |
| 带日期事件 | 6 | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| 时长 | 6 | 0.8333 | 1.0000 | 1.0000 | 1.0000 |
| 顺序任务 | 6 | 0.4167 | 0.9167 | 0.9167 | 0.7500 |
| 因果 | 6 | 0.0000 | 0.7778 | 0.7778 | 0.5000 |
| 别名与延迟别名 | 6 | 0.6667 | 1.0000 | 1.0000 | 0.9167 |
| 角色弧三段 | 6 | 0.2222 | 0.6667 | 1.0000 | 0.7417 |
| 稳定特质 vs 爆发 vs 恢复 | 6 | 0.5556 | 0.9444 | 1.0000 | 1.0000 |
| 缺失信息 | 6 | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| 字段冲突 | 6 | 0.8333 | 1.0000 | 1.0000 | 1.0000 |

门槛（spec 写死，退化即红）：总体 recall@3 ≥ 0.90、recall@10 ≥ 0.97、MRR ≥ 0.87；
modern recall@10 ≥ 0.97 且 MRR ≥ 0.87；fantasy recall@10 ≥ 0.96 且 MRR ≥ 0.87；
直接事实维度 recall@10 = 1（B-1 核心承诺，零余量）。阈值取实测下取整，系统确定性
下可精确复现，余量仅防浮点表示抖动。

**最弱位（词法上限定位，B-2 靶点）**：df2 改写查询（偏爱/饮品 vs 最常喝/饮料，首中
rank 7）、ar3 关系弧（抽象词「关系/变化」无词法锚点，rank 5）、ca2 两跳根因链
（链上中间记录无查询词，r@10 仅 0.3333）。三者的共性是**查询与目标无共享实词 bigram**，
是词法检索的原理性上限，不是分词 bug。

## B-2 dense 检索如何用同一矩阵做 A/B

1. 语料与指标零改动：`buildCorpus()` + `runMatrix(corpus, denseSearchAdapter)`，
   dense 检索器实现同签名适配器（query → 有序 {id, score} 列表）即可接入。
2. A/B 报告 = 同一张维度 × 世界表跑两遍（lexical vs dense / vs 融合），重点看三处
   词法上限位（df2 / ar3 / ca2）是否抬升、以及直接事实维度是否保持 1.0 不回退。
3. 融合排序（dense-gate / RRF / must-keep）沿用本矩阵做回归：门槛 spec 的 BASELINE
   更新为融合后实测值即可，语料哈希不变保证跨版本可比。
4. 门槛本身即 B-2 的合并门：任何新检索管线必须 ≥ 本基线（总体 r@10 0.97 / MRR 0.87），
   防止 dense 引入后词法精确档（直接事实、专名）回退。

## 已知局限与边界（如实记录）

- **覆盖面 = MemoryStore.search**。`tavern_history_search` 的分级阈值匹配逻辑在
  plugin 内部闭包里（`packages/plugin/src/agent-tavern/agent.ts`），不可独立 import；
  v1 不覆盖。两者共享同一 `tokenizeQuery`（分词器同源），词法召回代表性足够，但分级
  AND/40% 阈值行为不在本矩阵内——plugin 侧由 `agent-tavern-cjk-search.spec.ts` 工具级
  测试守着。若后续把分级匹配抽到 tavern-store 导出，可零成本并入本矩阵。
- **词法上限**：改写/抽象查询（df2/ar3/ca2）的缺口是 bigram 子串匹配的原理性上限，
  基线如实记录低分而非放宽 ground truth。
- **缺席判定在答案层**：纯缺失例只验证「不虚构」，检索层无可判输出，故单列不计分。
- **freshness/删除/过期行为面不在矩阵内**（时间戳全固定的必然代价），由单元测试覆盖。
- **语料规模**：130 记录 / 66 用例的受控矩阵，测的是检索器行为模式，不是大规模性能；
  压测另做。
- **同世界 65 条含 6 条低先验填充噪音**：规模小于真实长会话库，词法命中率因此偏乐观；
  A/B 对比（相对值）不受影响，绝对值不应外推为生产召回率。
