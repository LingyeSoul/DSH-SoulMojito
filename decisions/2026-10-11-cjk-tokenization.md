# B-1 中文分词修复记忆检索（CJK-aware tokenization）

日期：2026-10-11。来源：docs/exploration/2026-10-11-jsr-lwb-reference.md §4 B-1（P0）。

## 问题

旧 tokenizer 用 `/[\p{L}\p{N}]+/gu` 切词，中文无空格，整句查询切成**单个巨型 token**。
模型用自然语言调 `memory_search` / `tavern_history_search`（如"林小雨欠的赌债还了吗"）
时只有逐字子串才命中，召回趋近于零。受影响的三份重复实现：

- `packages/tavern-store/src/memory.ts`（MemoryStore.search 词法打分）
- `packages/plugin/src/agent-tavern/agent.ts`（tavern_history_search 的 AND 门槛）
- `packages/plugin/src/agent-novel/writer.ts`（agent-novel 自有副本，见下文"不动"决策）

## 方案

新模块 `packages/tavern-store/src/tokenize.ts` 导出 `tokenizeQuery`（单一来源，index.ts
再导出；plugin agent.ts 经既有的 `../../../tavern-store/src/index.js` 相对导入复用）：

- 拉丁字母/数字连续段 → 整词 token（小写化，与旧行为一致）；
- CJK 段（\p{Script=Han} + 平假名 + 片假名 + 谚文，按 Unicode script 判定）→
  全部相邻 bigram；长度 1 保留单字 token（单字查询语义）；
- 两端均为中文虚词的 bigram 丢弃（停用字符表见源码常量，降噪——"还了""了吗"
  这类功能词组合会稀释匹配率）；
- 实现要点：先剥离 CJK run 再提拉丁词，否则 `[\p{L}\p{N}]+` 从拉丁位置起步会
  贪婪吃进相邻汉字，产生 "vip卡" 跨脚本词（测试首轮即抓到此 bug）。

假名/谚文策略：与汉字统一走 bigram 展开。日文/韩文同样是无空格书写，整句单
token 的问题相同；bigram 是次优但可用的粗检索方案。停用表只含中文虚词，不波及
假名/谚文 bigram。

**MemoryStore.search**：打分公式不变（lexical×100 + importance×10 + confidence×5 +
freshness），lexical = matched/total 在展开后的 bigram 集上计算。

**tavern_history_search 分级匹配**（bigram 展开后严格 AND 对自然语句过严——
"雨欠"这类跨词界组合在改写句中必然缺失）：

- 展开后 token 数 ≤ 3 → 严格 AND（专名精确查询语义，2-3 字中文名的 bigram
  集恰落在此档）；
- > 3 → 阈值匹配：命中数 ≥ ceil(**40%** × 总数) 才入选；命中列表按命中数降序、
  同数按楼层倒序（严格 AND 档全命中数相等，稳定排序退化为旧的楼层倒序扫描序，
  行为不变）。excerptAround 不变（已天然锚定最靠前的命中 token 位置）。

工具 description 微调：query 参数描述从 "Every word must appear in a message" 改为
描述分级语义（≤3 全含 / 长查询 40% 入选、最优在前）。memory_search 的
"Lexical search query" 语义仍成立，不改。

## 对规格的两处微调（及理由）

1. **阈值 60% → 40%**：规格自举示例"林小雨欠的赌债还了吗"（展开 7 token）在
   目标楼层"林小雨在赌场欠下赌债"上命中 3/7 ≈ 43%——ceil(60%×7)=5 会拒掉规格
   自己举的目标场景。bigram 的跨词界组合系统性 miss，天然压低上限；40%（≈
   过半实词证据）让该示例通过（3 ≥ ceil(2.8)=3），噪音控制交给排序、limit 与
   停用 bigram。
2. **停用表补"还"**：规格给的字符表不含"还"，但示例文字明确点名"'还了''了吗'
   这类功能词组合"应被停用——表与例自相矛盾，按例子的意图补入。实义搭配
   不受损（规则要求两端都在表内，"还钱""还债"照常保留）。

## 否决的替代方案

- **jieba-wasm（LWB 路线）**：违反本插件零运行时依赖纪律（bundle 自包含）；
  WASM 生命周期管理（预加载/降级）复杂度不成比例。
- **整句 phrase token**：即现状，召回为零，正是要修的。
- **单字 unigram**：命中率高但单字噪音大（"的""了"处处命中），AND 语义彻底
  失效，无法保留专名精确查询档。
- **LWB 式实体词典最长匹配保护**：需要按会话注入角色名/别名词典并管理失效，
  v1 用"专名 bigram 全保留 + ≤3 严格 AND"达到近似效果（2-3 字名的 bigram 集
  严格 AND 等价于连续包含），后续记忆升级（B-2 起）再评估。

## 调用方决策记录（grep 全量后逐一确认）

| 调用面 | 处置 | 理由 |
|---|---|---|
| tavern-store MemoryStore.search | 接入新 tokenizer | 词法打分面，本修复主目标 |
| agent-tavern tavern_history_search | 接入 + 分级阈值 | 词法 AND 面，本修复主目标 |
| agent-tavern memory_search | 随 MemoryStore 受益 | 工具层无本地分词 |
| agent-tavern tavern_lore_search | **不动** | 走 tavern-lore 的 activateWorldInfo 世界书关键词激活语义，非词法检索面 |
| agent-novel（writer.ts 的 tokenizeQuery/matchesAllTokens 副本） | **不动** | novel_lore_search 与 writer 自动 lore 的 matchWorldEntries 把 token 同时喂给 key-包含激活分支与内容词法分支，novel_body_search 是有序扫描语义（排序分级需另行设计）；超出 B-1 范围，留待 agent-novel 中文检索单独立项。仓库因此存在两份 tokenizer（tavern-store 新版 / agent-novel 旧版），已在 agent-novel 侧源码注释互相指认的必要性留待该立项处理 |

## 验证

- `packages/tavern-store/tests/tokenize.spec.ts`（9 例：tokenizer 单元 + MemoryStore
  中文召回/专名/英文回归）；
- `packages/plugin/tests/agent-tavern-cjk-search.spec.ts`（7 例：history/memory 工具级
  中文自然语言召回、专名精确、阈值挡噪音、中英混排、单字、纯虚词报错、英文回归）；
- 既有回归：agent-tavern 全系列 + agent-novel 全系列 + tavern-store store.spec 共
  20 文件 318 测试通过；`tsc -b` 干净。
