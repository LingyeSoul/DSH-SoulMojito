# JS-Slash-Runner 与 LittleWhiteBox 竞品参考

> 调研日期：2026-10-11。来源：浅克隆本地检出的 `JS-Slash-Runner`（酒馆助手 Tavern-Helper v4.11.3，c0196ca）与
> `LittleWhiteBox`（小白盒 v3.1.6，66cb100），两个仓库源码全量通读（JSR 178 个源文件；LWB modules/ 下
> 2133 个文件按模块分层抽读，重点模块读到实现层）。对照方：本仓库 Mod 系统（提案 0015）、记忆/变量面
> （提案 0004/0006/0012）、美化前端 iframe 面。
>
> **许可纪律**：JS-Slash-Runner 为 PolyForm NonCommercial 1.0.0，LittleWhiteBox 为 Apache-2.0。与 SillyTavern
> 同款边界——本文档只记录**可观察行为语义与机制设计**，施工时一律重新实现，不复制两家源码。
>
> **承重结论抽查**：JSR iframe 无 sandbox/CSP（grep 零命中 + 模板目验）、LWB recall v9 九阶段架构（文件头
> 注释目验）、LWB agent-core DeepSeek 思考+工具特判（README:46-58 目验），三三通过。其余结论以两仓库
> 文件路径为证据坐标，施工前应按坐标复核。

## 1. 定位与总体结论

| | 定位 | 与本插件的关系 |
|---|---|---|
| JS-Slash-Runner | ST 脚本运行时：**同源、无 sandbox、无 CSP** 的 iframe，从 `window.parent` 直拷约 200 个 API（`src/iframe/predefine.js`） | Mod 面板 / 美化前端 iframe 面的直接竞品，信任模型与本插件相反 |
| LittleWhiteBox | ST 单体巨型扩展：浏览器侧 223 文件的分层记忆系统 + 沙箱 OS + 后端生图 + mini 编码 Agent | 记忆检索 / 变量守卫 / 长时任务工程方案的直接竞品 |

总体结论：两家最值得吸收的不是功能清单，而是三类东西——

1. JSR 的 **Mod 生命周期基础设施**（声明式按钮、事件订阅分组注销、错误归属、日志查看器）——本插件的
   桥架构（双向 postMessage + 宿主托管反注册）复刻成本极低；
2. LWB 的 **$schema 变量写入守卫**（280 行规格书现成）与**记忆多阶段召回管线**（本插件记忆质量的天花板差距）；
3. 两家的**工程纪律**（confirmable save 读回验证、replay 对齐测试、gold-eval 评测、开工前八项表）。

反面结论同样明确：JSR 的零隔离安全模型与 LWB 的 xiaobai-os 全量 OS 框架**不复刻**（见 §5）。

## 2. JS-Slash-Runner 机制情报

### 2.1 iframe 运行时（与本插件的根本分歧）

- 两类 iframe（脚本 `src/panel/script/Iframe.vue`、消息渲染 `src/panel/render/Iframe.vue`）均**无 sandbox
  属性、无 CSP**；消息渲染 iframe 与脚本 iframe 注入同一份 `predefine.js`——AI 产出的美化前端 HTML 同样
  拥有全量宿主 API。
- API 注入：`_.pick(window.parent, [...])` 整对象拷贝 + `_.omit(TavernHelper, '_bind')` 平铺 + `_bind`
  内函数 `bind(window)` 后去下划线注入（`src/iframe/predefine.js:11-19`）；共享宿主 jQuery/lodash/toastr
  实例（`src/iframe/parent_jquery.js`）。
- 加载模式：srcdoc 默认 / Blob URL 可选（方便 F12 调试），内容变化与卸载 `revokeObjectURL`
  （`src/panel/render/Iframe.vue:10-25`）。
- 视口正确性：iframe 内 `100vh` 失真，用正则把 vh 替换成 `--TH-viewport-height` CSS 变量（CSS/内联/JS
  四种形态，`src/panel/render/iframe.ts:5-75`）+ 宿主 resize 时 postMessage 通知。
- iframe 身份双保险：id 缓存到 `window.__TH_IFRAME_ID` 与 `window.name`，防 Firefox 移除 srcdoc iframe 后
  `frameElement` 失联（`predefine.js:2-10` 注释明说）。

### 2.2 事件系统

- 宿主监听 ST 事件后暴露给脚本 `tavern_events` 全集 70+（`src/function/event.ts:185-268`）+ 自定义
  `iframe_events` 8 个（渲染起止、生成请求/开始/结束、流式 token fully/incrementally 四通道）。
- **订阅按 iframe 分组**：`Map<iframe_name, Map<event_type, Map<listener, wrapper>>>`（`event.ts:9-17`），
  iframe `pagehide` → `eventClearAll` 整组注销——脚本关闭后监听器零泄漏，不依赖 GC。
- 生成管线拦截点：`GENERATION_REQUESTED` 直接传 config 对象引用可原地改写（`generate/index.ts:398`）；
  流式增量做了 `cleanUpMessage` + 引号/星号配对补全（`responseGenerator.ts:105-137`）；`before_end` 事件
  可改写最终落盘文本（L134）。

### 2.3 脚本管理

- 三级作用域容器：全局 / 角色（按 avatar）/ 预设（`src/store/scripts.ts:4-100`），跨容器拖拽、搜索支持
  `/正则/`。
- 角色卡/预设内嵌脚本自动装载（存 `data.extensions.tavern_helper`），**首次遇到弹知情同意**
  （`use_check_enablement_popup.ts:46,110`）、`popuped` 数组防重复打扰、改名/删除同步迁移。
- 导入强制 `enabled=false` + 换新 uuid（防导入即执行）；**导出角色卡时按脚本粒度临时剥离私有 data/buttons、
  事后恢复 + 10s 超时兜底 + summary toast**（劫持 fetch 拦 `/api/characters/export`，
  `store/settings/character.ts:103-151`）。
- 内置库：从 jsdelivr fetch 分类脚本一键导入（`src/panel/script/Builtin.vue:94-118`）——轻量脚本市场。

### 2.4 声明式按钮（独门设计）

脚本在清单静态声明 `{name, visible}` 按钮 → 宿主渲染进 ST 的 Quick Reply bar（MutationObserver 兼容
QR v2 combined 模式，`use_button_destination_element.ts`）→ 点击 `eventSource.emit(button_id)` → 脚本
`eventOn(getButtonEvent('按钮名'))` 监听（`src/type/scripts.ts:4-8`、`src/store/iframe_runtimes/script.ts:47-61`）。
按钮可运行期用 `replaceScriptButtons` 动态改。

### 2.5 错误呈现三件套

console 劫持双写宿主日志 store（`src/iframe/node_modules/log.js` + `src/store/iframe_logs.ts`）→ toastr
报错带 `[iframe名]` 前缀 + stack 完整展示（`src/function/util.ts:43-72`）→ 面板日志查看器按脚本筛选
（`src/panel/toolbox/Logger.vue`）。

### 2.6 宿主污染回收（实验，默认关）

`src/iframe/cleanup_protector.js`（316 行）：`window.parent` 换 Proxy 记录写入、DOM createElement 打
`data-th-iframe-id` 标、pagehide 时还原全局变量 + 删除打标 DOM。还原用劫持前保存的 original 引用避免
二次记账（L1-4 注释）。本插件 sandbox 架构下不存在此问题，但其记账/打标/还原手法是通用坑解。

### 2.7 踩坑记录（CHANGELOG 与注释中提炼）

- Vue/pinia 生产标志必须预置，否则 pinia 4.0+ 第三方脚本全体失效（`predefine.js:22-24`，4.8.19 事故）。
- 切角色/预设时 iframe `pagehide` 早于宿主 store 切换，脚本自省 API 失败（四处 TODO 未解）——**卸载
  时机要先通知清理、再切上下文**。
- ST 事件 message_id 参数 string/number 混杂，需 parseInt 归一（`event.ts:39-54`）。
- 渲染/宏替换双管线导致 iframe 双渲染，mount 前须清除已存在 iframe（两处防御）。
- 流式渲染 edge case 簇（编辑后不重渲、`<details>` 嵌套、Show more messages，4.6-4.7 连环修）——**本插件
  "流式期间不执行"的保守策略是对的**。
- 同名角色卡按 name 绑定串档（4.11.0 改 avatar）——作用域键必须用不可变 id。
- 导出剥离必须超时兜底，否则用户数据被永久剥离。

## 3. LittleWhiteBox 机制情报

### 3.1 story-summary 分层记忆（223 文件，核心竞争力）

**存储分层**：L0 StateAtom（逐楼场景锚点，LLM 提取 `{scene, edges:[{s,t,r}], where}`，设计注释引用
BGE-M3 与 TransE）/ L1 Chunk（楼层原文块）/ L2 Event（总结事件，带 `causedBy` 因果边）/ L3 Fact。总结
本体在 chat metadata，向量在 IndexedDB（msgpack float32 LE）。

**召回引擎 recall v9**（`modules/story-summary/vector/retrieval/recall.js:1-30` 注释即架构图，阈值集中在
:109-149 CONFIG）：

1. Query Build（确定性无 LLM，读末尾 3 楼切分段落提 focus terms）；
2. R1 Dense（3 段 batch embed 按长度加权）；
3. Query Refinement（用 R1 命中产出 hints 段）；
4. R2 Dense（复用 R1 向量 + hints 重加权）；
5. Lexical 检索 + **Dense-Gate**（词法命中的 event/floor 必须再验 dense 相似度：floor≥0.50 / event≥0.60，
   v8→v9 调参痕迹在注释）；
6. Floor 级 W-RRF 融合（RRF_K=60）+ **must-keep**（高 IDF≥2.2 查询词命中的楼层保底 3 层，稀有专名不被
   融合平均吃掉，`recall.js:556-626`）；
7. Rerank（每层拼"完整 USER + AI 前三锚点邻块"成文档，调 bge-reranker-v2-m3）；
8. L1 配对（每层取 top-1 AI chunk + top-1 USER chunk 作证据）；
9. L0→L2 反查 + causedBy 因果链 BFS（maxDepth=10，注入上限 30）+ PPR 扩散。

**分词**（`vector/utils/tokenizer.js`）：结巴 WASM（中文）+ TinySegmenter（日语）+ 拉丁空格分割，
stopwords-iso 三语停用词，实体词典（角色/别名表）分词前最长匹配保护；WASM 未就绪降级为实体保护+标点
分割。**中文词法检索必须自带分词器。**

**总结生成**：每 N 楼增量切片（单次 ≤100 楼）→ 已有总结+facts 喂 LLM 流式回 JSON → merge → 写回带
乐观并发校验（生成前后三次校验 store 未变，`generator.js:187-196,237-242`）。

**记忆维护 Agent**（`docs/memory-maintenance-target-design.md` 262 行规格 + `maintenance/` 26 文件）：
总结提交后自动跑的纠错 Agent——工具面 ReadMemory/SearchSource/ReadSource/EditMemory/CompleteMaintenance；
核心场景是**跨批次事件合并**（同一剧情事件横跨两个总结批次时查原文做语义合并、保留前者身份、重定向
引用，规格书 §3.1 例 E1）；完成收据=范围并集，人工编辑自动"退役"对应子范围下轮重扫；run 上限
（198k 输入 / 256 次请求含失败）+ 独立 summaryAdapter 压缩（不污染主会话）。

**成本优化**：同轮复用（swipe/续写/重生成复用召回结果，0 嵌入 0 重排，失效条件表现成，
`docs/recall-reuse-verification.md`）+ 预取（用户输入期间算召回，真正生成时 join，
`generate/recall-prefetch.js`）；真实链路验收 12 次复用 0 次新增请求。

**undo 链**：有唯一键的数据存 keyed-changes 差量（前值+生成值按 key diff），无键整表快照；"不可回滚
则拒绝生成"纪律（`data/summary-undo.js:83-120`、`generator.js:121-124`）。

**向量缓存包**：ZIP 含 SHA-256 输入摘要（`JSON.stringify([kind, embeddingInput])`）检测来源错配，一笔
IndexedDB 事务原子替换（`docs/vector-cache-packages.md`）。

### 3.2 variables state2：$schema 写入守卫

`modules/variables/state2/README.md`（280 行完整规格）：`<state>` 块内 `$schema` 定义结构模板，模板
**不是提示词建议而是写入守卫**——结构/类型锁定、`$range/$step` 越界 clamp、`$enum` 枚举校验、`$ro`
只读递归生效、数组项模板锁定、`"*"` 动态对象键、空对象 `{}` 表示可扩展；set 是整体替换不是 merge。
全部确定性规则执行，无 LLM 结算（手写 parser 544 行 + executor 827 行 + guard-core 351 行）。
配套 `after-ai-gate`（DOM 稳定检测 + 消息签名防重放 + ticket 队列）决定结算时机。与 MVU 不兼容、自成
体系；本插件的 MVU 确定性结算方向与之一致，**缺的只是守卫层**。

### 3.3 draw / agent-core / server-plugin（工程模式情报）

- **confirmable save**：ST `saveChatConditional` 吞异常、等锁超时静默不保存——"写完 marker 后从服务端
  **读回验证**在场才继续"（`docs/backend-draw-runs.md:333-343`）。
- **后端任务纪律**：幂等 requestId、per-owner 串行调度、资源限额写死、404 不区分不存在/无权、capability
  协商缺失明确报错不静默回退。
- **DeepSeek 思考+工具特判**（`modules/agent-core/README.md:46-58`）：直连 DeepSeek 显式开思考+带原生
  工具时 `tool_choice: required` 须转 `auto` 且回传已有 `reasoning_content`。**维护者确认本插件宿主侧
  已处理，无需行动，仅存档备查。**
- **token 计数**：`/count` 可能在失败时返回 HTTP 200 + 估算值，不能当成功凭据；计数走 `/encode` 并校验
  count 与 token IDs。

### 3.4 gold-eval 评测体系（`scripts/gold-eval/`）

- **authoring**：真实聊天金标准流水线，候选**仅凭引用原文独立验证**才收，离线准备零 API。
- **dev-matrix**（`dev-matrix/controlled-cn.mjs`）：受控中文记忆矩阵——**真相先行 + 两套同构干扰世界**
  （现代/奇幻），维度：直接事实/不确定信息/日期/时长/顺序/因果三层（直接 vs 根因 vs 相关混淆）/别名/
  延迟别名/角色弧三段/稳定特质 vs 爆发 vs 恢复/缺失信息/字段冲突——每类都是已知 LLM 记忆失败模式。
- **三消费者**：reader-only（冻结 Prompt 喂 reader 模型确定性评分）/ prompt-only（外部调用必须为 0）/
  recall-cassette（按 `host+path+requestHash` 命中冻结响应，miss 即 invalid 不回退 live API）。
- **replay 对齐**（`scripts/story-summary-replay-runner.mjs`）：聊天导出 JSONL → Node 内存 IndexedDB →
  逐楼推进跑**同一份生产代码** → 比较正式入口与回放入口的注入文本/请求是否一致。证明执行一致性，
  不证明算法质量。
- **请求纪律**：request-journal 意图先占预算、fsync 后交付、恢复不重跑已成功请求、未知计费请求需四参数
  精确批准——评测基建自己的花钱问题也被工程化。

### 3.5 次要模块（一句话档案）

- **scheduled-tasks**：每 N 楼自动执行一段 STscript 的调度器（冷却 50 楼 + 防重放）。
- **message-preview**：fetch 包装实现"生成不入楼"，历史 10 条。
- **reply-progress**：只观察宿主真实请求信号做进度上报，不从插件事件猜（`host.js:14-16`）。
- **ena-planner**：发送前 LLM 规划 → 放回输入框人确认 → 发送的两段式（与本插件行动候选同族）。
- **story-outline**：世界书绑定的 NPC 管理 + 周期 LLM 世界推演——轻量世界模拟器。
- **assistant**：ST 里的 mini 编码 Agent（工作区文件 + apply-patch + Plan 账本 + JS API + Skills）。
- **template-editor**：角色级消息渲染模板（正则捕获组 + iframe 沙箱渲染）。
- **plugin-update**：完全委托 ST 原生 `/api/extensions/version|update`，零自建。
- **文档纪律**：每功能 target-design / implementation-plan / verification 三件套 + 开工前八项表
  （所有者/唯一事实来源/持久态/临时态/外部依赖/注册入口/**删除路径**/兼容对象）。

## 4. 复刻 / 改进建议总表

优先级依据：对质量/成本的影响 × 施工成本。D-1（DeepSeek 特判）经维护者确认宿主已修复，不列入。

| # | 建议 | 来源 | 落点 | 优先级 |
|---|---|---|---|---|
| B-1 | **中文分词修复**：`tokenizeQuery` 用 `[\p{L}\p{N}]+` 切词，中文整句成单 token，自然语言查询基本无法召回（`agent.ts:928-935`、`tavern-store/src/memory.ts:91-106` 单路词法） | LWB tokenizer | memory/history 检索 | **P0** |
| C-1 | **$schema 变量写入守卫**：结构/类型锁定、range/enum/ro 守卫进 MVU 确定性结算，整类消灭"模型写坏结构"失败 | LWB state2 规格书 | mvu 结算执行器 + 回执 | **P0** |
| A-1 | **Mod 桥下行事件 + 声明式按钮**：manifest 声明按钮、`api.onButton`、`POST mods/<id>/button/<name>`、桥加 `mod-event` 下行；订阅按 mod 分组、卸载整组退订 | JSR §2.4/§2.2 | mods host/client/manifest/http | **P0** |
| A-2 | **Mod 错误呈现三件套**：mod UI 自动注入 console 劫持上报 + 客户端环形缓冲 + 面板日志查看器 | JSR §2.5 | client + reply.html 注入 | **P0** |
| B-2 | 多阶段召回管线（渐进：先 dense 单路 + 词法融合，再 dense-gate/RRF/must-keep） | LWB recall v9 | memory 检索 | P1 |
| B-3 | 记忆维护 Agent + 完成收据（跨批次事件合并是必测样例） | LWB maintenance | memory + subagent | P1 |
| B-4 | 同轮复用 + 召回预取 | LWB | ~~检索层~~ **评估免施工**（pull-based 模型 + 向量持久化 + 查询 memoize 已覆盖，见施工进度节） | ~~P1~~ |
| B-5 | replay 对齐 + gold-eval 评测基建（compaction/AgentNovel 同样适用） | LWB gold-eval | 测试基建 | P1 |
| A-3 | 流式 token 事件（fully/incrementally 双通道）暴露给 mod（只推 Node 侧，不动 iframe 渲染） | JSR responseGenerator | generation-hooks | P1 |
| A-4 | iframe 运行时细节：vh→CSS 变量、身份 window.name 双保险、Blob URL 调试模式 | JSR §2.1 | FrontendFrame/ModSurface | P1 |
| D-2 | confirmable save 读回验证（写宿主侧状态后必须成立的操作） | LWB | session binding/投影 | P1 |
| C-2 | varevent 条件规则引擎（中文操作词别名 + 回合后排队执行） | LWB | Mod 示例或 MVU 扩展位 | P2 |
| B-6 | undo 链（keyed-changes 差量）与向量缓存包（SHA-256 输入摘要） | LWB | memory/MVU 回执 | P2 |
| D-3 | after-ai-gate（稳定检测代替裸事件，防流式期重复结算） | LWB | ~~MVU 触发点~~ **评估免施工**（服务端 post-save 单点触发，无浏览器 DOM 竞态，见施工进度节） | ~~P2~~ |
| D-4 | message-preview 式"生成不入楼"（卡片工作台试写预览） | LWB | workbench | P2 |
| D-5 | 楼层驱动任务调度（每 N 楼执行 STscript + 冷却 + 防重放） | LWB scheduled-tasks | Mod v2；**已部分落地**：`chat-saved` 载荷补 `floorCount`，Mod 自行比对即可实现每 N 楼调度 | P2 |
| D-6 | reply-progress（只观察宿主真实请求信号） | LWB | 生成进度 | P2 |
| D-7 | 文档纪律：开工前八项表补"删除路径"栏 | LWB | 提案模板 | P2 |
| A-5 | 精选 Mod 仓库（jsdelivr 一键导入）+ 本地热重载通道 | JSR 内置库/开发者页 | mod 生态 | P2 |
| A-6 | 提示词查看器 + 世界书激活追踪（调试基建天花板，工程量大） | JSR wi_tracer | 面板 | P2 |

**施工进度**：P0 四项（B-1 / C-1 / A-1 / A-2）与 P1 六项（B-5a / A-3 / A-4 / B-2 / D-2 / B-3）已于
2026-10-11 全部落地（决策文档 `decisions/2026-10-11-cjk-tokenization.md`、
`decisions/2026-10-11-mvu-schema-guard.md`、`decisions/2026-10-11-mod-bridge-buttons-logs.md`、
`decisions/2026-10-11-retrieval-eval-matrix.md`、`decisions/2026-10-11-mod-stream-delta.md`、
`decisions/2026-10-11-iframe-viewport.md`、`decisions/2026-10-11-confirmable-session-writes.md`、
`decisions/2026-10-11-memory-maintenance.md`，提案 0016）。B-4 / D-3 经架构评估**无需施工**
（见下表注），D-5 以 `chat-saved.floorCount` 载荷部分落地。**P1 至此收官**；P2 剩余：A-5 精选
Mod 仓库、A-6 提示词查看器/世界书追踪、C-2 varevent 规则引擎、B-6 undo 链/向量缓存包、
D-4 生成不入楼、D-6 reply-progress、D-7 文档八项表。

**两项架构评估结论（2026-10-11）**：
- **B-4（同轮复用 + 预取）无需施工**：LWB 的动机是 push-based 召回每次 swipe/重生成重算嵌入费；
  dsh 是 pull-based 工具模型（模型按需调 `memory_search`），向量按记录版本持久化、查询串进程内
  memoize（B-2 已带）——LWB 要优化的重算成本结构在 dsh 不存在。
- **D-3（after-ai-gate）无需施工**：LWB 的动机是浏览器侧结算观察 DOM/流式的竞态；dsh 的 MVU
  结算是服务端 runGeneration post-save 单点触发（失败项重试是显式新一次结算），无 DOM 竞态与
  重放暴露面。若未来出现浏览器侧结算触发再引入。

## 7. B-2 前置探路：DSH 宿主 embedding 能力审计（2026-10-11）

对 DSH `0.2.0-rc.2` 隔离运行时（`.npm-cache/dsh-runtime`）的审计结论：**宿主没有 embedding/rerank seam**。
dsh-llm 唯一调用面是 chat `stream`（`@deepseek-ai/dsh-llm/lib/types/index.d.ts:412`），`LlmAdapter`
无 embed 钩子、`StreamChunk` 词汇表无数值向量、wire 协议层（pi-ai `PROTOCOLS`）全为 chat 家族、
`text-embedding|/embeddings` 全包 grep 零命中。**B-2 必须自带 OpenAI 兼容 embed 端点配置**（LWB 同款
路线），最小形状：插件设置级三件套 `{baseURL, apiKeyEnv（env 名引用而非明文）, model}` + 聊天级检索
参数；rerank 先用 `api.llm` 做 LLM-based 重排或推迟。附带发现：`GenerateOptions.purpose` 封闭枚举
（'compaction'|'session-title'）不可私加新值；pi-ai 目录里 openai 兼容系 provider 的 baseURL+key 天然
能服务 `/embeddings`，可作 embed 配置的默认值提示但插件读不到宿主 settings 内部，仍需用户显式配置。

## 5. 不复刻清单（差异化边界）

1. **JSR 零隔离安全模型**：无 sandbox、无 CSP、parent 直拷 API、共享 jQuery/lodash。这是历史包袱不是
   设计资产——本插件 `sandbox="allow-scripts"` + CSP `connect-src 'none'` + 清单门控 + 审计在隔离性上严格
   一个量级。**抄它的善后机制（事件注销、错误归属、导出防泄漏），不抄它的边界。**
2. **LWB xiaobai-os 全量 OS 框架**（1077 文件、App 全第一方）：本插件 Mod 系统是第三方扩展路线，方向
   相反。其 kernel 分区事务（单分区坏不拖垮桌面）对 Mod v2 有概念参考价值，但进程内同住架构下
   "审计+跳过+三层开关"已达到近似效果。
3. **LWB 自带 7-provider agent-core**：本插件复用 DSH 宿主 LLM 路由是更干净的架构选择。
4. **JSR 宿主 DOM 注入 / builtin 直暴露 ST 内部函数**：与"不透传宿主 ctx"的 Mod API 纪律冲突。

## 6. 施工注意事项（两家踩坑的直接映射）

- Mod 按钮的 iframe 下行事件：订阅必须按 mod 分组，iframe 卸载/disable 整组退订（JSR pagehide 模式）。
- Mod/作用域键一律用不可变 id，绝不用 name（JSR 同名角色串档事故）。
- hook 宿主原生流程必须有超时兜底（JSR 导出剥离 10s 恢复）。
- 事件参数做类型归一（JSR message_id string/number 混杂事故）。
- B-1 分词：实体词典（角色名/别名）做最长匹配保护，专名不被切碎（LWB tokenizer 的核心教训）。
- C-1 守卫：clamp 与 reject 要分开进回执——clamp 是"调整后值 + 原因"，reject 是失败项可重试，与现有
  MVU 回执语义对齐。
- 新 iframe 注入物（console 上报脚本）只走 token 对账的 postMessage，不得开任何新网络面。
