# 0016 · B-2 混合记忆检索（dense + 词法 RRF 融合）

状态：已实施（v1）。前置：B-1 中文分词（0bac59a，决策 2026-10-11-cjk-tokenization）、
B-5a 检索评测矩阵（6f7c683）、DSH 宿主 embedding 能力审计
（docs/exploration/2026-10-11-jsr-lwb-reference.md §7）。

## 开工前八项表（CONTEXT.md 纪律；规则晚于本文落地，补记于 2026-10-11 审查修复）

| 项 | 答案 |
|---|---|
| 所有者 | embed 客户端 `packages/plugin/src/memory-embed.ts`；融合编排 `packages/plugin/src/memory-hybrid.ts`；向量持久化 `packages/tavern-store/src/memory-vectors.ts`（cosine/rrfFuse 融合原语亦在此，与离线评测同源）；配置读写 tavern-store state |
| 唯一事实来源 | 配置 = `TavernState.memoryEmbedding`（state.json，normalizeMemoryEmbedding 容错读取）；向量 = `<tavern>/memory-vectors/<scope>/<scopeId>.json` sidecar（digest 检测 stale） |
| 持久态 | 三件套配置（key 只存 env 名引用不存明文）、向量 sidecar、运行状态 sidecar（dims 基准/熔断窗口/lastError） |
| 临时态 | 查询向量 memoize（32 条）与熔断窗口计时，进程内即失（重启熔断复位是可接受代价） |
| 外部依赖 | OpenAI 兼容 `/embeddings` 端点（用户自配 baseURL/model/dims）；宿主无 embedding seam（审计结论 §7），网络面全在插件自带客户端 |
| 注册入口 | HTTP `GET/PUT/POST memory/embed(/test)` 三路由 + 面板第 15 分区「记忆检索」；memory_search/write/update/forget 工具签名零改动（编排内挂接） |
| 删除路径 | 删 memory-embed.ts / memory-hybrid.ts / memory-vectors.ts + 三路由 + 面板分区 + state 键 `memoryEmbedding`（置 undefined 即回落纯词法）+ 数据目录 `<tavern>/memory-vectors/`；记忆记录本体不动 |
| 兼容对象 | v1 红线：缺配置/熔断/全 stale ⇒ `memory_search` 逐字节等于纯词法（golden 三路锁死）；score 字段保持词法分（模型侧输出语义不变）；retrieval-matrix 门槛原样绿；AgentNovel 投影不在 v1 挂接面（§8） |

## 0. 动机

B-1 把中文自然语言查询的词法召回从趋近于零修到了可用水位（B-5a 基线：总体
recall@10 0.97 / MRR 0.87），但词法匹配有结构性上限：**改写敏感维度**——别名
（alias）、角色弧三段（arc）、因果混淆（causal）等（评测矩阵最弱位
df2/ar3/ca2 一类）里，查询与目标的字面交集可以接近零（"林小雨欠的赌债还了
吗" vs "她把债务清了"），bigram 分词救不了语义等价。dense 检索（查询与记录
各自嵌入、cosine 排序）是这类差距的标准解法；LWB recall v9 的九阶段管线验证
了这条路在 RP 记忆上的收益，也验证了它的工程成本（见 §8 关系与边界）。

审计结论（§7）：DSH 0.2.0-rc.2 宿主**没有 embedding seam**——dsh-llm 唯一
调用面是 chat stream，`LlmAdapter` 无 embed 钩子、wire 协议层全为 chat 家族。
因此 B-2 自带 OpenAI 兼容 `/embeddings` 端点配置（三件套），key 走 env 名引用。

**v1 红线：缺配置 = 功能整体关闭，`memory_search` 纯词法、逐字节等于现状
（golden 测试锁死）。** 检索质量门槛 `retrieval-matrix.spec.ts` 原样绿——它
直接调 `MemoryStore.search`，本提案不改词法通道一行打分逻辑。

## 1. 配置面

设置级三件套+，存 `TavernState.memoryEmbedding`（state.json，与 compaction
覆盖同款持久化路径；读取容错 `normalizeMemoryEmbedding` 在 tavern-store）：

```ts
interface MemoryEmbeddingSettings {
  baseURL: string      // POST {baseURL}/embeddings；http(s)，去尾斜杠
  apiKeyEnv: string    // POSIX env 变量名（/^[A-Za-z_][A-Za-z0-9_]{0,255}$/）；
                       // 空串 = 免密反代（不发送 Authorization 头）
  model: string
  dims?: number        // 1..8192；缺省用首次成功观察到的维度做一致性基准
  batchSize?: number   // 单请求批量上限，默认 16，夹取 1..64
  timeoutMs?: number   // 单次请求超时，默认 10000，夹取 200..120000
}
```

- 三件套（baseURL/model）缺任一或非法 ⇒ `normalizeMemoryEmbedding` 返回
  undefined ⇒ 功能整体关闭。手改 state.json 同样安全回落。
- `apiKeyEnv` 语义：解析时读 `process.env[apiKeyEnv]`；**未设或值为空/空白 ⇒
  免密**（LWB 同款：Key 留空 = 不发送 Authorization 头，不是发送空串）。key
  明文永不入库、不进日志/审计/接口响应（见 §7）。

### HTTP 管理面（index.ts）

| 路由 | 行为 |
|---|---|
| `GET /memory/embed` | 返回 `{config, status}`：config 为脱敏三件套（apiKeyEnv 只是名字）；status 含 `configured/keyless/envResolvable/breakerOpen/breakerUntil/model/dims/lastError/lastErrorAt/lastSuccessAt` |
| `PUT /memory/embed` | 校验（apiKeyEnv POSIX 名给专属 400 文案；整体不合法给形状 400）→ `patchState` → **清空运行状态 sidecar**（旧端点的 dims 基准/熔断窗/错误记录作废）。三件套全空 = 清除配置 |
| `POST /memory/embed/test` | 探针：embed 固定串 `dsh-tavern embed probe`，返回 `{ok, dims, latencyMs, model}` 或 400+错误。探针是显式用户动作，**无视熔断**直接尝试；成功即复位、失败照常开窗 |

客户端：管理面板第 15 个分区「记忆检索」（`registerPanelSection`，client/main.js
`MemoryRetrievalBand`）——三件套 + 可选数值字段表单、状态行（含熔断/最近错误）、
保存/清除/测试按钮。i18n zh/en 键集镜像（gates locale 校验兜底）。

## 2. embed 客户端纪律（plugin/src/memory-embed.ts）

服务端零依赖（global fetch），纪律取自 LWB 的失败教训（Apache-2.0 参考只取
机制语义，不抄代码）：

- **批量**：按 `batchSize` 分批顺序请求（不并发轰端点），body
  `{model, input: string[]}`。
- **重试**：429/5xx/网络错误/超时 → 固定短退避 250ms 后**重试一次**；其他 4xx
  （配置类错误）不重试。
- **超时**：每次尝试独立 `AbortController` + `timeoutMs`；超时归类 timeout
  （可重试）。
- **响应校验**：`data` 数量与输入一致；每项 `embedding` 是有限数值数组；批内
  维度一致；与 `config.dims ?? status.dims`（首次成功记录的基准）不一致 ⇒
  报错（防止静默换模型后新旧向量混空间）。OpenAI 兼容端点带数字 `index` 时按
  index 对齐输入序。
- **熔断**：任何一次整体 embed 失败（重试耗尽）⇒ `lastError` + 60s 熔断窗
  （`EMBED_BREAKER_MS`）；窗口内一切 embed 尝试短路，检索自动纯词法；成功即
  复位。**跨 bundle**：index.mjs（HTTP 路由）与 agent.mjs（记忆工具）是独立
  esbuild bundle，熔断/状态走 `<tavern>/memory-vectors/status.json` 文件
  sidecar（原子写、最后写者胜——最坏影响是另一 bundle 多做一次注定失败的
  尝试）；查询向量 memo 是进程内的，按 bundle 各自生效。
- **探针**：`embedProbe` 成功/失败自身落账（任何调用方可见状态一致）。

## 3. 向量存储与 digest（tavern-store/src/memory-vectors.ts）

`MemoryVectorStore`：纯持久化、零网络（网络与熔断一律在插件层）。布局与
MemoryStore 同根目录 sidecar：

```text
<tavern>/memory-vectors/<scope>/<encodeURIComponent(scopeId)>.json   # 每 scope×scopeId 一文件
<tavern>/memory-vectors/status.json                                  # 运行状态 sidecar（插件层写）
{ "version": 1, "entries": { "<id>": { "digest", "model", "vector" } }, "updatedAt" }
```

- `vector` = base64 float32 LE（编解码 `encodeVector`/`decodeVector` 导出）。
- **digest = SHA-256(JSON.stringify([model, content]))**——LWB vector-cache
  packages 的等价语义：content 或 model 变更 ⇒ digest 不匹配 ⇒ stale ⇒ 懒重
  嵌。digest 按全文 content 计算；嵌入输入截断到 6000 字符（64KB 记忆会撞主流
  端点的输入上限，整批 400 会白开熔断窗）——截断只影响向量输入，不影响 stale
  判定。
- API：`get(id, scope, scopeId)` / `put(entries)` / `delete(id, scope, scopeId)`
  / `list(scope?, scopeId?)`（含 digest/model 供 stale 判定）。
- 原子写走仓库统一 `writeAtomicText`（fs-atomic.ts：唯一 tmp 名 + Windows
  rename 重试）；损坏文件按空缓存处理（可重建缓存，不抛错阻断检索）。

## 4. 写入路径（agent.ts 编排）

memory_write / memory_update 落盘成功后（memory_forget 顺带删向量缓存）：

1. 配置存在且熔断闭合 → **同步** embed（受 timeoutMs×2 约束）→ 向量落盘
   （digest 按新内容+当前 model）。
2. embed 任何失败 **不阻塞工具返回**：错误进 lastError + 熔断，向量保持
   stale/缺位，后续检索懒补。

> 本仓库没有 memory_patch 工具（写入面是 write/update/forget），规格中的
> memory_patch 落点即 update 覆盖。AgentNovel 的 memory 投影走 novel commit
> 管线（projector.ts），不在 v1 挂接范围（见 §8）。

**懒回填**：检索时发现目标 scope 候选池里有 stale/缺失向量且熔断闭合 → 请求
前按词法序批量回填，**单次检索最多 32 条**（`HYBRID_BACKFILL_LIMIT`，防 40 条
存量记忆的首搜卡死）；回填失败走熔断，已有新鲜向量照常参与本次融合。

## 5. 融合算法（plugin/src/memory-hybrid.ts）

词法通道完全复用现状：`MemoryStore.search` 的 token 匹配率×100 +
importance×10 + confidence×5 + freshness。dense 通道只接管**排序**，不改打分
——importance/confidence/freshness 经由词法通道继续生效，工具输出的 `score`
字段语义不变（仍是词法分）。

流程（`hybridMemorySearch`）：

1. 熔断开 ⇒ undefined（调用方回落词法）。
2. 查询嵌入（`model+baseURL+query` 键进程内 memo，上限 32 条 FIFO）。失败 ⇒
   熔断开窗 + undefined。
3. 词法候选池：每 scope `store.search(limit: 50)`（MemoryStore 的 MAX_RESULTS
   上限），合并后按（score 降序，id 升序）定词法名次——与旧工具合并序一致。
4. 向量新鲜度判定 + 懒回填（§4）。
5. dense 名次：新鲜向量按 cosine(query, record) 降序（id 升序稳定并列）。
6. **双通道 RRF**（k=60 等权）：`score(d) = Σ_channel 1/(60 + rank)`；两通道
   都出现的记录取两项之和，单通道记录取该通道贡献，无向量记录只走词法通道。
7. 融合序：rrf 降序 → 词法名次 → id（全确定性）；截 limit 后统一施加
   maxTokens 预算（与 MemoryStore 逐条预算同款算法，跨 scope 施加）。

## 6. 降级矩阵

| 状态 | 行为 |
|---|---|
| 无配置 / 配置非法 | 整体关闭：写路径零 embed，检索纯词法，**逐字节等于 B-2 之前**（golden） |
| 熔断打开（60s 窗） | 检索短路纯词法（golden）；写路径跳过嵌入 |
| 查询 embed 失败（重试耗尽） | 熔断开窗 + 本次纯词法（golden） |
| 候选全部 stale/缺失 且回填失败 | dense 通道空 ⇒ undefined ⇒ 本次纯词法（golden） |
| 部分记录无向量 | 缺位记录只走词法通道，其余正常融合 |
| 回填成功 | 融合序生效（这是唯一改变检索行为的路径） |

golden 由 `packages/plugin/tests/memory-hybrid.spec.ts` 锁死：无配置/查询嵌入
失败/全部 stale 三条路径的工具输出与文件内复刻的 B-2 之前词法组合逐字节
`toEqual`。

## 7. 安全边界

- **key 只存 env 名**（`apiKeyEnv`，对齐宿主 dsh-credentials 的 CredentialRef
  风格）：明文 key 永不入 state.json、不入向量文件、不进 lastError/审计/任何
  接口响应；解析只发生在请求发出的瞬间且只进 `Authorization: Bearer` 头。
- GET 状态接口回显 `apiKeyEnv`（名字）与 `envResolvable`（env 是否有非空值），
  不回显 key 值。
- 免密反代：`apiKeyEnv` 空串 / env 未设 / env 值空白 ⇒ 不发送 Authorization
  头（显式合法形态，不是错误）。
- embed 请求只发给配置的 baseURL（用户显式配置的端点）；错误信息只含状态码
  与响应摘要（200 字符），不含请求头。
- `normalizeMemoryEmbedding` 在读取侧兜底：state.json 被手改成非法形状 ⇒ 功能
  安全回落关闭，不产生不可控请求。

## 8. 与 LWB recall v9 的关系 / v2 留白

v1 ≈ LWB recall 九阶段的**第 1 阶段（向量召回）+ 第 6 阶段（融合）的最小等价
物**：dense 召回 + RRF 融合 + 向量缓存 digest 失效 + 熔断/重试纪律。刻意
**不做**（v2 候选，按 LWB 实测收益排序）：

- dense-gate（词法已高置信时跳过 dense，省请求）；
- must-keep 规则（关键记忆无条件保送）；
- rerank（宿主无 rerank seam；LLM-based rerank 走 api.llm，成本敏感）；
- 两轮 refinement（先粗检索再按缺口补查）；
- 同轮复用/预取（LWB 的成本优化层）；
- AgentNovel 记忆投影的 dense 接入（写路径在 novel commit 管线，需 projector
  侧编排）；
- cassette 化端到端评测（真实端点录制回放）。

## 9. 评测计划

- **CI 内（零网络）**：`memory-hybrid.spec.ts`（客户端纪律/存储/融合/写路径/
  golden）+ `retrieval-matrix.spec.ts`（词法门槛原样绿，锁"不退化"）+
  `memory-vectors.spec.ts`（tavern-store 侧）。
- **CI 外（真实端点）**：`scripts/retrieval-eval/run.mjs --dense`（v1 交付，
  见脚本头注释）——同一语料与指标实现上跑词法 vs 混合的 A/B 对比表，供配置
  端点后的人工验收；依赖真实 embed 服务，不入 CI。
- 质量门槛的 dense 基线数字待真实端点 A/B 后由 orchestrator 统一写入（本提案
  不动 README 测试基线数字）。

## 10. 测试面

| 文件 | 覆盖 |
|---|---|
| `packages/plugin/tests/memory-hybrid.spec.ts` | embed 客户端（批量/重试/超时/维度/免密头/熔断 60s/探针）、RRF+cosine 纯函数、全链路（融合序/golden×3/memoize/回填上限 32/写路径成功与失败/update 重嵌/forget 清理） |
| `packages/tavern-store/tests/memory-vectors.spec.ts` | 向量编解码/digest/CRUD/scope 隔离/原子写落盘形态/损坏容错/normalizeMemoryEmbedding |
| `packages/plugin/tests/agent-tavern-cjk-search.spec.ts` | 既有中文检索行为（无配置 ⇒ golden，不改动语义） |
| `packages/tavern-store/tests/retrieval-matrix.spec.ts` | 词法质量门槛（不改动语义，原样绿） |
