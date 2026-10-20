# 提案 0020：AgentNovel 原作导入续写与正文优化

> 状态：已实施（2026-10-20）。设计日期：2026-10-20。前置提案：[0005](0005-agent-novel-architecture.md)（存储、调度、提交协议）、[0007](0007-agent-novel-writer-subagent.md)（子代理执行面）。本文是「导入原作续写」与「正文优化」的唯一设计说明；0005 的提交、认领、完成守卫契约保持不变，本文只新增两条工作流。

## 1. 目标与设计结论

两个产品能力：

1. **导入小说续写**：用户导入 TXT / Markdown / EPUB 原作，系统按章节解析，再按目标长度把章节切成多个部分；每个部分交给一次性子代理提取时间线、角色卡、世界书与文风；主代理把提取结果熔炼成项目圣经（bible），再按用户续写要求创建续写大纲、分单元写作。
2. **正文优化**：用户对某一章已提交正文提出修改要求（文风、节奏、细节、语句），修订子代理返回整章改写稿；结果先作为待应用版本，用户/作者显式应用后才进入阅读投影。

核心选择：

1. **原作不是本项目正典**。导入文本只作为「已有文本」参考与提取来源，不进入 `commits`、不计入新书字数；续写正文仍只经 `novel_body_commit` 产生。
2. **解析与切分在服务端完成，不经过模型**。章节识别与按长度切分是纯函数，避免模型接触整本原文、也避免 token 成本与格式漂移。
3. **提取逐部分子代理化**。每个部分一次无工具推理子代理，输出严格 JSON；结果落盘为不可变对象，不进入主会话上下文。
4. **主代理只做熔炼**。`novel_import_read` 返回有界 digest（抽样摘要 + 去重角色/世界条目 + 时间线头尾 + 原文尾部），主代理据此产出统一 bible；`novel_import_merge` 校验并落盘，同时物化角色卡与世界书资产。
5. **续写仍走既有大纲/单元/提交协议**。bible 只是规划材料；续写大纲、场景、章节完成与全书完成完全复用 0005。
6. **正文优化是追加式投影，不是改写历史**。已提交正文对象不可变；优化记录覆盖「应用时已存在的该章提交」，之后的新提交追加在优化稿之后。预算与完成守卫按有效正文计算。
7. **失败必须可见**。提取部分有尝试上限；耗尽即暂停并给出部分 id 与原因。优化稿在长度或结构越界时拒绝落盘，原有正文保持不变。

```text
导入原作（TXT/MD/EPUB）
  -> 服务端解析章节 + 按目标长度切分部分
  -> 创建 importing 项目（原文部分不可变落盘）
  -> driver 调度 import-extract：每批部分交给无工具子代理提取
  -> 全部提取完成 -> driver 调度 import-merge
  -> 主代理 novel_import_read（有界 digest）-> novel_import_merge（熔炼 bible + 物化资产）
  -> 既有 outline-create / write-unit 续写
  -> 用户要求优化某章 -> 修订子代理 -> 待应用版本 -> 显式应用/放弃
```

## 2. 导入解析与切分

### 2.1 章节识别

`parseImportedNovelText`（`packages/tavern-store/src/novel-import.ts`）按行识别：

- Markdown 标题 `#` / `##` / `###`；
- 中文标题：`第…章/节/回/卷/部/篇/集`、`序章`、`楔子`、`引子`、`前言`、`尾声`、`后记`、`终章`、`番外…`；
- 英文标题：`Chapter/Part/Book N`、`Prologue/Epilogue/Interlude/Afterword/Foreword/Preface`。

至少识别出 2 个有正文的标题章时才按标题分组；否则按篇幅切成伪章节（`chapterSource: 'pseudo'`），标题为「第 N 节」或 `Part N`。首个标题前的短前言（<200 有效字符）并入第一章，长前言独立成章。

### 2.2 部分切分

- 目标部分长度 `partTargetCharacters` 显式传入，范围 `[2000, 50000]`，无默认魔法。
- 以空行分段；累计到目标即切分，段落不跨部分拆分。
- 单段超过目标 1.5 倍时按句末标点切句；仍超长再按 code point 硬切。
- 部分 id 稳定为全局序号 `imp-<n>`，章节 id 为 `ich-<n>`；`order` 为全书顺序。
- 超过 600 个部分拒绝导入，提示提高目标长度或拆分文件（避免不可控的子代理批次）。

### 2.3 落盘与完整性

`<novel>/imports/parts/<partId>.txt` 是原文的唯一事实来源；`ImportedPart.contentHash`（sha256）与 `effectiveCharacters` 在每次读取时校验，不匹配即 `NovelStorageCorruptionError`，不静默降级。

## 3. 提取子代理

每个部分一次 `spawn`（宿主 SubAgent seam，`agentPreset` 为内部无工具推理组合，`toolFilter.allow: []`）：

- 输入：固定提取协议 + 书名/章节名/部分序号 + 前一部分末尾 600 字（连续性参考）+ 本部分原文；
- 输出：单个 JSON 对象：
  - `summary`（≤800 字）
  - `timeline[]`：事件摘要、参与角色、`major|minor`
  - `characters[]`：姓名、别名、身份、性格、外貌、动机、关系、结尾状态、置信度
  - `worldEntries[]`：标题、检索键、类别、内容
  - `openThreads[]`
  - `style`：视角、语气、节奏、文风、对话风格
- 服务端 `normaliseImportExtraction` 做严格类型校验与上限裁剪；字段缺失按空值处理，类型错误拒绝。
- 每部分提取尝试上限 3 次（`IMPORT_MAX_PART_ATTEMPTS`）；耗尽后工具把小说暂停为 `recovery-required`，detail 带部分 id 与最后一次错误。

结果写入 `imports/extractions/<sha256>.json`；快照只保留 `extractionHash`、`summary`、状态、尝试次数与错误，避免每次 revision 复制大对象。

## 4. 熔炼 bible

### 4.1 digest（主代理可见材料）

`novel_import_read` 无参数时返回 `buildImportDigest`：

- `sampleSummaries`：最多 36 条，按部分顺序均匀抽样；
- `timeline`：最多 80 条，保留开头 20 条与结尾 60 条；
- `characters`：按姓名合并，别名并集，后出现字段覆盖空字段，按出现次数排序，最多 60 个；
- `worldEntries`：按标题去重，键并集，较长内容胜出，最多 80 条；
- `openThreads`：去重后最多 40 条（保留最近）；
- `style`：最后一个部分的文风；
- `sourceTail`：原文最后 2400 字；
- 进度、章节目录、已物化资产引用与 `next` 指引。

digest 在组装后按 JSON 字节数硬上限 48 KB 逐级压缩（摘要/时间线/角色/世界条目数量与单字段长度分级收紧），因此主代理上下文不会随原作长度无界增长。若需要某个部分的完整提取，按 `partId` 读取。

### 4.2 熔炼载荷

`novel_import_merge` 接收 `{story, timeline, characters, worldEntries, styleNotes, openThreads}`：

- 校验与 4.1 同构，但时间线最多 300、角色 80、世界条目 160、连载线索 80；
- bible 记录写入 `imports/bibles/<sha256>.json`，包含 `bibleRevision`（内容 hash16）、`mergedAt`、`sourcePartCount`；
- 角色物化为 V2 角色卡资产：`description` 合并身份/外貌/结尾状态，`personality`、`scenario` 来自提取字段，别名/关系/动机/置信度进入 `extensions`；
- 世界条目物化为一份世界书资产 `导入原作设定 · <书名>`，每条带检索键与内容；
- 资产按内容 hash 去重并加入 `snapshot.assets`，续写大纲用 `novel_outline_read` 返回的 `assets` 引用；
- 全部部分必须 extracted 才能熔炼；相同 bible 重试幂等回放收据，不同 bible 重试拒绝；
- 熔炼后 `run.phase` 从 `importing` 进入 `outlining`。

## 5. 续写与既有协议的关系

- 续写大纲是**新书大纲**，不包含原作章节；原作章节只出现在 `import.chapters`。
- 导入项目的首条指令仍是续写要求，走既有 `req-1` 与 `novel_outline_create`。
- 手动审批模式：导入与提取照常自动进行；首份续写大纲保存后进入 `awaiting-approval`（`runAfterOutlineChange` 的 `initialOutline` 分支）。
- 写手包新增 `Imported-source continuity` 块（仅导入项目）：原作 premise/结局方向/文风、最近时间线、未收线索、原文尾部 2000 字；VM 按单元变化，放在稳定前缀之后，不破坏字节稳定布局。
- 写手与作者可用 `novel_source_read` / `novel_source_search` 核对细节；两者都是只读，已加入写手 allow list。

## 6. 正文优化

### 6.1 修订子代理

`novel_body_optimize { chapterId, instruction }`：

- 读取该章**有效正文**（已应用优化稿 + 后续提交）；该章有 claimed 在途单元时拒绝生成，避免优化稿与未提交正文交叉；
- 输入固定修订协议 + 书名/章节目的/故事前提/结局方向/文风/优化要求 + 原文；
- 输出纯文本（段落以空行分隔），比长 JSON 字符串更稳健；
- 服务端拒绝结构标题、章节号、完成标记；有效字符比必须在 `[0.60, 1.60]`，否则拒绝并保留原文；
- 结果写入 `bodies/<bodyHash>.txt`，生成 `pending` 的 `BodyRevisionRecord`；同一章已有 pending 版本时先标为 discarded，保证单待应用版本；
- 生成时携带读取正文时的 `contentRevision` CAS：若生成期间章节有新提交或新应用的优化，落盘被拒绝并要求重新优化，避免优化稿覆盖新正文。

### 6.2 应用语义

`BodyRevisionRecord` 保存 `coveredCommitIds`（生成时该章全部提交）与 `baseContentRevision`（生成时的有效正文版本）。应用时先校验 `baseContentRevision` 仍等于当前 `contentRevision`，否则拒绝；避免生成期间的新提交被优化稿覆盖。应用时：

- 同章旧 `applied` 版本变 `superseded`，新版本变 `applied`；
- 阅读投影 / `readBody` / 导出 / 章节 Markdown = 优化稿 + 未被覆盖的后续提交；
- 提交记录本身不变；`bodyHashOf` 仍返回提交 hash；
- 字数统计与硬上限使用有效正文：`effectiveChapterCharacters` / `effectiveNovelCharacters`；
- 应用前检查硬上限；超限抛 `NovelLengthLimitError`，待应用版本保留，可放弃或继续修改；
- `novel_body_revision_discard` 只把 pending 标为 discarded，不删除正文对象（审计保留）。

## 7. 数据模型与存储

快照新增可选字段（旧快照缺省视为 null/空，不升 schemaVersion）：

```ts
interface NovelSnapshot {
  import?: NovelImportState | null
  bodyRevisions?: readonly BodyRevisionRecord[]
}
```

目录新增：

```text
imports/parts/<partId>.txt          # 导入原文，不可变
imports/extractions/<sha256>.json   # 每部分提取结果，不可变
imports/bibles/<sha256>.json        # 熔炼 bible，不可变
bodies/<hash>.txt                   # 优化稿正文（与提交正文同目录、同格式）
```

`NovelPhase` 增加 `importing`；`WorkIntentKind` 增加 `import-extract` / `import-merge`。

## 8. 调度

`nextWork` 顺序新增最前置分支：

1. `import` 存在且 `bibleHash === null`：
   - 仍有未提取部分 → `import-extract`；
   - 全部 extracted → `import-merge`；
2. 其后完全沿用 0005：outline-create → requirement revise → write-unit → chapter-complete → finish。

driver notice 新增两种指令文案：分批调用 `novel_import_extract`；读取 digest 后调用 `novel_import_merge`。导入阶段进度签名按「已提取部分数 + bible hash」计算，提取推进即重置停滞计数。

## 9. 工具、HTTP 与面板

### 9.1 工具（作者面新增 9 件）

- `novel_import_read` / `novel_import_extract` / `novel_import_merge`
- `novel_source_read` / `novel_source_search`
- `novel_body_optimize` / `novel_body_revision_read` / `novel_body_revision_apply` / `novel_body_revision_discard`

写手 allow list 增加 `novel_source_read`、`novel_source_search`。

### 9.2 HTTP

- `POST novels/import/preview`：解析并返回章节/部分预览，不创建项目；
- `POST novels/import`：创建导入项目（source 为文本或 EPUB base64；请求上限 24MB）；
- `GET novels/:id/import`：导入进度与章节目录；
- `GET novels/:id/import/chapter?chapterId=&cursor=&limit=`：原文分页；
- `POST novels/:id/optimize`、`.../optimize/apply`、`.../optimize/discard`；
- `GET novels/:id/revision?revisionId=&cursor=&limit=`：优化稿分页；
- `GET novels/:id` 详情新增 `import` 与 `bodyRevisions` 投影，章节字数使用有效正文。

### 9.3 面板

- 新建小说表单新增「原创 / 导入原作续写」模式：文件选择、每部分目标字符数、解析预览（章节数/部分数/字数/识别方式）。
- 小说详情新增导入面板：进度、原作章节列表与原文阅读。
- 阅读栏新增「优化本章正文」；优化弹窗支持填写要求、生成预览、应用/放弃。
- 右侧新增待应用优化版本列表（应用/放弃），已应用版本摘要。

## 10. 失败模式与边界

| 场景 | 行为 |
|---|---|
| 空文件 / 全空白 | `NovelConfigError: imported source is empty` |
| 部分数量 > 600 | 拒绝并提示提高目标长度或拆分 |
| EPUB 非法 | HTTP 400，`invalid EPUB source: …` |
| 提取输出非法 JSON / 缺字段 | 记为该部分失败，保留错误；重试至上限 |
| 提取尝试耗尽 | 暂停 `recovery-required`，detail 带 partId 与最后错误；用户 resume 时未完成部分的尝试计数清零（显式重试授权），已提取结果不变 |
| 未全部提取就熔炼 | `NovelPreconditionError{rule:'import-parts-pending'}` |
| bible 已合并且内容不同 | `NovelPreconditionError{rule:'import-already-merged'}` |
| 优化稿过短/过长/带标题 | 拒绝落盘，原文不变，错误含原因 |
| 优化后超硬上限 | 应用时 `NovelLengthLimitError`，待应用版本保留 |
| 无子代理运行时 | 提取/优化返回 `NovelCapabilityError`，不伪造成功 |

## 11. 测试

- `packages/tavern-store/tests/novel-import.spec.ts`：中/英/Markdown 标题、伪章节、超长段落、参数边界、提取/bible 校验、digest 去重与抽样。
- `packages/tavern-store/tests/novel-import-store.spec.ts`：导入创建、逐部分提取、digest、熔炼与资产物化、原文读取/搜索、重复熔炼幂等；优化稿待应用/应用/放弃、提交不可变、有效字数、硬上限拒绝。
- `packages/plugin/tests/agent-novel-import.spec.ts`：工具面逐部分子代理提取、digest、熔炼；优化工具生成待应用版本并显式应用。
- `packages/plugin/tests/agent-novel-command.spec.ts`：HTTP 预览/创建/详情/原文读取。
- `packages/plugin/tests/agent-novel-outline.spec.ts`：`nextWork` 的 import-extract → import-merge → outline-create 顺序。
- `packages/plugin/tests/agent-novel-tools.spec.ts` / `agent-novel-writer.spec.ts`：工具面与写手 allow list 契约更新。

## 12. 实施记录与偏离

1. **提取结果不进入快照正文**：只保留 hash 与摘要；digest 在读取时组装。避免每次 revision 复制大 JSON。
2. **bible 记录带 `sourcePartCount`**：原文部分数用于 UI/审计；bible 本身不复制原文。
3. **熔炼幂等前置**：先比较已存 bible 内容，再校验 `expectedRevision`；因此成功后的重试即使 revision 过期也能回放收据。
4. **优化稿长度守卫**：`[0.60, 1.60]` 为实施期常量，未产品化为配置；超出即拒绝，避免模型把「优化」做成删改剧情。
5. **优化覆盖范围**：生成时覆盖该章全部现有提交；应用后新提交追加在后。再次优化会覆盖「当前有效正文」，包括上一版优化稿。
6. **手动审批**：`runAfterOutlineChange` 增加 `initialOutline` 参数，使导入项目的首份续写大纲也进入审批门；后续修订行为不变。
7. **写手包导入块**：位于正典页之后、单元参数之前，属于单元尾段；同一单元材料内字节稳定。
8. **面板优化入口**：HTTP 优化需要宿主子代理运行时；面板在未打开作者会话/运行时不可用时返回 503，不静默降级为作者内联改写。

## 13. 工程检查表（CONTEXT.md 八项）

| 项 | 结论 |
|---|---|
| 所有者 | 领域/解析：`tavern-store/src/novel-import.ts`；持久化：`NovelStore`；模型执行：`plugin/src/agent-novel/importer.ts`；调度：`driver.ts`/`outline.ts`；HTTP：`http/novel.ts`；面板：`client-src/92-ui-novel.js` |
| 唯一事实来源 | `snapshot.import` + `imports/parts/*.txt`；提取/bible 以 hash 寻址的不可变 JSON；正文以 `commits` 与 `bodyRevisions` 为准 |
| 持久态及理由 | 原文部分、提取、bible、优化稿正文必须落盘：续写跨进程、跨 turn，且优化稿要可回放/审计 |
| 临时态 | 提取子代理运行、HTTP 优化请求、面板预览；重启即失，可重试 |
| 外部依赖 | 宿主 SubAgent seam（提取/优化）；HTTP 上传（TXT/MD/EPUB） |
| 注册入口 | `nextWork` 两个工作类型、driver notice、9 个作者工具、2 个写手只读工具、8 条 HTTP 路由、面板新建/详情 |
| 删除路径 | 删除小说目录即清空全部导入/优化数据；代码删除后旧快照的 `import`/`bodyRevisions` 缺失或多余字段都被视为 null/空，不影响既有 0005 流程；不升 schemaVersion |
| 兼容对象 | 0005/0007 的旧快照、旧工具调用、旧面板；旧快照无新字段时按 null/[] 读取 |

## 14. 首版不做

- 导入原文的逐句对齐、章节重命名或人工编辑；
- 运行时替换/追加原作（更换来源需要新建项目）；
- 优化稿的逐段 diff 高亮与自动合并；
- 针对优化稿重新提交 canon changes（优化被定义为文风/语句层改写，不改事实）；
- 多语言标题的完整 NLP 识别（当前为正则启发式，可在 `novel-import.ts` 扩展）。
