# ST 能力补齐施工契约 · Wave 2（2026-11-12）

Wave 1 契约见 [`2026-11-12-st-capability-fix.md`](2026-11-12-st-capability-fix.md)。Wave 2 在 Wave 1 全部落地并通过集成后执行；文件所有权从 Wave 1 释放后生效。

## 0. 范围

Wave 1 已覆盖生成内核、聊天文件、输入辅助、消息 UI、Agent 注入、资产/宏。Wave 2 只做：

1. **Data Bank / 文件 RAG**（ST 核心 RAG；复用现有 embed 基础设施）。
2. **世界书 vectorized 检索**（用 Data Bank 的向量通道；不新建第二套向量库）。
3. **整库备份 / 恢复**（assets + chats + state + 可选 data-bank）。
4. **事件桥补投递**（只在宿主有真实观测面时补；没有就明确不做，禁止假事件）。

不做：TTS、图像生成、翻译、表情/立绘、主题/背景/CSS、ST 扩展安装兼容层、token logprobs。

## 1. 文件所有权

| Owner | 文件 |
|---|---|
| G Data Bank | `packages/plugin/src/data-bank.ts`（新）、`packages/plugin/src/http/data-bank-routes.ts`（新）、`packages/plugin/src/agent-tavern/tools/data-bank.ts`（新）、`packages/plugin/src/agent-tavern/agent.ts`、`packages/plugin/src/mods/cross-bundle.ts`（工具计数/行）、`packages/plugin/src/http/routes.ts`、`packages/plugin/scripts/gates/run.mjs`、`packages/plugin/src/generation/pipeline.ts`（仅 vectorized 注入点）、`packages/tavern-lore/src/engine.ts`（仅 vectorized 排除/命中接口）、`packages/tavern-store/src/store.ts`（新增 dataBank 元数据键，若需要） |
| H 备份/事件 | `packages/tavern-format/src/zip.ts`（新增 writer）、`packages/plugin/src/http/backup-routes.ts`（新）、`packages/plugin/src/http/routes.ts`、`packages/plugin/src/helper.ts`（仅 snapshot 附加 lore）、`packages/plugin/client-src/10-frontend-frame.js`、`packages/plugin/client-src/90-panels-core.js`、`packages/plugin/client-src/40-i18n-en.js`、`packages/plugin/client-src/41-i18n-zh.js`、`packages/plugin/scripts/gates/run.mjs` |
| 主代理 | README、docs、bundle 构建、最终集成 |

同一文件在 G/H 之间冲突（`routes.ts`、`run.mjs`）：G 先完成并交付补丁，H 在 G 的文件基础上继续；不并行编辑同一文件。若必须并行，主代理合并。

## 2. Data Bank 契约

### 2.1 存储

- 目录：`tavernDataRoot()/data-bank/`。
- 每个文件一个 JSON 元数据 + 原始文本：`<id>.json`，`<id>.txt`。
- `DataBankFile = { id, name, mime, size, createdAt, chunks: { index, text }[], embedding?: { model, dims } }`。
- id 用稳定哈希（文件名 + 内容 SHA-256 前 16 位），重复上传同内容幂等。
- 只接受文本类：`text/plain`、`text/markdown`、`application/json`、`text/csv`；上限 2 MB；不接受二进制/可执行。
- 路径必须 `path.resolve` 后校验在 data-bank 目录内。

### 2.2 路由

- `POST import/data-bank` `{ name, contentBase64 }` → `{ id, name, chunks }`。
- `GET data-bank` → 列表（不含正文）。
- `DELETE data-bank/<id>`。
- `POST data-bank/search` `{ query, limit }` → `{ hits: [{ id, name, chunkIndex, text, score }] }`。
- `PUT chat-data-bank` `{ character, chatId, ids }`：写 `chat_metadata.dataBankIds`（ST 附件语义）。

### 2.3 检索

- 有 embed 配置：`embedTexts` 查询向量 + 文件 chunk 向量（sidecar `<id>.vectors.json`），余弦 top-K。
- 无 embed / 熔断：词法 fallback（CJK-aware token 交集，复用现有分词逻辑）。
- 查询向量缓存用 `memoizedQueryVector`。
- 失败必须明确返回错误或降级到词法并带 `mode: 'lexical'`，不静默返回空。

### 2.4 注入

- **Agent 工具** `data_bank_search`：参数 query/limit，返回命中块与来源；只读。
- **ST 生成**：`chat_metadata.dataBankIds` 非空时，用最近一条用户消息检索 top-K（默认 4），作为 system 块注入（标注 reference data, not instructions）；字符上限 4000，超限截断。
- **Agent 自动注入**（可选，随 `agentContextInjection`）：context 部件加一块 top-K；字符上限 3000。
- 不改变 AgentLoop，不新增主循环。

### 2.5 面板

- 「数据银行」分区：上传（文本文件/粘贴）、列表、删除、附加到当前聊天、检索测试。
- 附件的 chat 级开关；不默认附加。

### 2.6 vectorized 世界书

- 语义：`vectorized=true` 的条目**不参与关键词匹配**，只通过向量命中；`constant=true` 仍常驻。
- 实现：在 lore 激活前，若启用 embed 且存在 vectorized 条目，对 query 做向量检索，命中条目以 `reason: 'vector'` 注入。
- 向量按 `entry content hash` 缓存（`lore-vectors.json`），条目内容变更即失效。
- 没有 embed 时：vectorized 条目保持不激活（不降级为关键词），并在提示词查看器/diagnostics 标注 `vector-unavailable`。
- 预算/位置/概率仍走现有引擎规则。
- 需要新增/修改的引擎接口必须保持同步 API 向后兼容；异步检索放在调用方（pipeline/agent），不把 `activateWorldInfo` 改成 async。

## 3. 备份契约

### 3.1 格式

- 导出一个 ZIP（stored，无压缩即可），文件名 `soulmojito-backup-<timestamp>.zip`。
- 内容：
  - `state.json`
  - `characters/`、`worlds/`、`presets/`、`personas/`（含 `avatars/`）、`groups/`、`chats/`
  - regex slice 与 frontend slice（`packages/tavern-store/src/store.ts:1834-1836` 的实际文件名，从常量读取，不硬编码）
  - `data-bank/`（可选，默认包含）
  - `manifest.json`：版本、生成时间、文件计数、SHA-256 清单。
- 不包含：密钥、环境变量、日志、绝对路径。

### 3.2 路由

- `GET export/backup` → ZIP 二进制（`application/zip`）。
- `POST import/backup` `{ zipBase64, mode: 'merge' | 'replace' }`：
  - 解析前校验路径穿越、大小上限（默认 256 MB）、zip 条目数上限。
  - `replace` 前自动创建 `backup-before-restore-<timestamp>/` 快照（同格式或目录副本）；失败可回滚。
  - `merge` 不覆盖同名资产，冲突计数上报。
  - 返回 `{ imported, skipped, conflicts, snapshot }`。
- 面板：备份/恢复入口 + 风险提示（replace 是破坏性操作，需二次确认）。

### 3.3 安全

- 禁止 zip slip；禁止符号链接；只写数据根内。
- 内容门禁：测试夹具全部合成，不含真实素材。

## 4. 事件桥契约

只补有真实观测面的：

- `MESSAGE_SWIPE_DELETED`：快照 diff 检测某楼 `swipes` 数量减少。
- `MESSAGE_UPDATED`：已有 `MESSAGE_EDITED` 之外的元数据变化（hidden/token/extra）可归入；若与 EDITED 重叠，明确择一，不双发。
- `WORLD_INFO_ACTIVATED`：helper snapshot 增加当前轮 lore 激活列表（来自 pipeline 的 trace），diff 后发事件（参数：激活条目数组）。
- `CHAT_CREATED` / `CHAT_DELETED` / `CHARACTER_*`：若 iframe 侧没有观测面（只绑定当前聊天/角色），**不做**，在兼容文档写明原因；不做假事件。
- 事件名使用 `TAVERN_EVENTS` 现有常量，不新增拼写。

## 5. 验收

- G：import/list/delete/search/chat attach 的路由 spec；embed 与词法 fallback 各一条；vectorized 命中/不可用/内容变更失效；ST 注入块上限；Agent 工具注册与 26 件计数同步。
- H：zip writer 的 round-trip（合成文件）；zip slip 拒绝；replace 前快照；事件 diff 的单测或客户端 gate 说明。
- 不跑 test/build；主代理统一跑 typecheck、vitest、build、gates。
- 报告格式同 Wave 1：文件、行为验收、测试、i18n key、风险。
