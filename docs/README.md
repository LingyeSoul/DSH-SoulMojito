# DSH-SoulMojito 文档索引

集中承载项目的全部长尾文档。根 [`README.md`](../README.md) 只保留产品面入口，实现细节、决策理由与证据链从这里进。

文档分类纪律见 [`CONTEXT.md`](../CONTEXT.md) 的「文档纪律」一节——提案是设计契约、决策是落地记录、探索必须带证据坐标，三者不互相复制。

## 提案（`proposals/`）

架构级新特性的设计契约，编号递增，实现后由根 README 挂链接。

| 提案 | 主题 |
|---|---|
| [`0001`](proposals/0001-tavern-architecture.md) | dsh-soulmojito 原生角色扮演层：当前架构、边界与后备路线 |
| [`0002`](proposals/0002-branch-persona-groups-script-textcompletion.md) | branch/bookmark、persona 管理、群聊、STscript/regex、Text Completion 的范围与格式 |
| [`0003`](proposals/0003-tavern-management-panel.md) | Tavern 管理面板（侧栏 footer 按钮 + `shell.overlay` 全面板） |
| [`0004`](proposals/0004-agent-tavern-architecture.md) | AgentTavern 原生 AgentLoop 架构、记忆/变量工具、遗忘策略与 ST 兼容模式 |
| [`0005`](proposals/0005-agent-novel-architecture.md) | AgentNovel 全自动小说推演架构（存储、调度、提交协议与作者干预） |
| [`0006`](proposals/0006-usage-anchored-compaction-pressure.md) | usage 锚定的压缩压力闸门 |
| [`0007`](proposals/0007-agent-novel-writer-subagent.md) | AgentNovel 写手子代理与有界写作上下文（inline / subagent） |
| [`0008`](proposals/0008-prompt-template.md) | Prompt Template（EJS）沙箱、作用域变量与内容注入 |
| [`0009`](proposals/0009-conversation-guides.md) | Conversation Guides（持续指引） |
| [`0010`](proposals/0010-turn-candidates.md) | Turn Candidates（行动候选生成） |
| [`0011`](proposals/0011-rewrite-with-feedback.md) | Rewrite with Feedback（带意见重写） |
| [`0012`](proposals/0012-mvu-settlement.md) | MVU 后台变量结算 + 回执 + 固定状态栏 |
| [`0013`](proposals/0013-card-workbench.md) | 卡片 Agent 工作台（对话改卡 + 确认协议 + 制卡/排错） |
| [`0014`](proposals/0014-script-play.md) | 剧本游玩模式（剧本库、绑定、对齐推进） |
| [`0015`](proposals/0015-mod-extensions.md) | Mod 扩展接口与加载机制（清单校验、三层开关、hook 总线、信任边界） |
| [`0016`](proposals/0016-hybrid-memory-retrieval.md) | 混合记忆检索（OpenAI 兼容 embed、向量 sidecar、RRF 融合、熔断/回填/降级矩阵） |
| [`0017`](proposals/0017-local-onnx-embed.md) | 本地 ONNX embed（provider 判别联合、目录指纹向量身份、dtype FP16 优先链） |
| [`0018`](proposals/0018-agent-game-bridge.md) | Agent 游戏桥——标准游戏引擎 + 侧边栏对局面 + Mod/导入扩展 |
| [`0020`](proposals/0020-novel-import-continuation-and-revision.md) | AgentNovel 原作导入续写（章节切分、逐部分提取、bible 熔炼）与正文优化 |
| [`0021`](proposals/0021-agent-tavern-body-ops.md) | AgentTavern 正文编辑、重生成与正文候选（DSH 原生 seam，不 fork） |
| [`0022`](proposals/0022-agent-tavern-write-rollback.md) | AgentTavern 正文重生成的写入回滚（MVU 变量、记忆/变量工具 journal） |
| [`0023`](proposals/0023-agent-tavern-mvu-body-switching.md) | AgentTavern MVU 正文编辑与候选切换（候选级 receipt） |

## 开发者文档（`mods/`、`games/`、`frontend/`）

面向扩展作者的接口参考：实现以源码为准，文档只讲契约与边界。

| 文档 | 主题 |
|---|---|
| [`mods/mod-api.md`](mods/mod-api.md) | Mod API v1：清单、生命周期、hook、工具、宏、STscript、面板 iframe、审计 |
| [`games/game-package.md`](games/game-package.md) | 游戏包格式：`game.json` 清单、纯函数引擎、自包含视图 |
| [`frontend/tavern-helper-compat.md`](frontend/tavern-helper-compat.md) | **美化前端可用的酒馆助手（TavernHelper）兼容面清单：可用 / 部分可用 / 不可用，及替代写法** |

## 治理（`content-policy.md`）

| 文档 | 主题 |
|---|---|
| [`content-policy.md`](content-policy.md) | 内容边界与使用责任（18+、禁止项、数据边界、ST 兼容标识） |

## 决策（`../decisions/`）

单次落地决策的记录：问题、方案、否决项、与规格的偏差。按主题分组，组内按时间升序。

### 架构与范围

- [`2026-08-15-v2-feature-scope.md`](../decisions/2026-08-15-v2-feature-scope.md) — v2 功能面的范围与形态选择
- [`2026-10-25-template-default-off.md`](../decisions/2026-10-25-template-default-off.md) — Prompt Template（EJS）默认关闭，profile 显式 opt-in

### 宿主兼容与 DSH 版本适配

- [`2026-08-16-occupy-blank-session.md`](../decisions/2026-08-16-occupy-blank-session.md) — 绑定会话占位：摘除宿主 blank 复用资格
- [`2026-08-17-internal-tavern-workspace.md`](../decisions/2026-08-17-internal-tavern-workspace.md) — Tavern 会话使用专用 DSH 工作区
- [`2026-09-09-dsh-bind-library.md`](../decisions/2026-09-09-dsh-bind-library.md) — 新建 `@dsh-tavern/bind` 收编跨版本宿主形状兼容层
- [`2026-09-09-import-turn-coordinates.md`](../decisions/2026-09-09-import-turn-coordinates.md) — 导入历史补 turn/step 载荷坐标，修复新建聊天空白
- [`2026-09-09-session-events-compat.md`](../decisions/2026-09-09-session-events-compat.md) — 会话事件日志读取兼容 DSH 0.1.2 的 Session API 变更
- [`2026-09-09-uiworkspace-connect-compat.md`](../decisions/2026-09-09-uiworkspace-connect-compat.md) — `connectWorkspace` 兼容 DSH 0.1.2 的 uiWorkspace 服务拆分
- [`2026-09-29-agent-tavern-mount-inject-compat.md`](../decisions/2026-09-29-agent-tavern-mount-inject-compat.md) — `dsh-tavern/agent` 不再直读插件作用域的 `ctx.agent`（DSH 0.2.0-rc.2）
- [`2026-09-29-host-ui-primitives-compat.md`](../decisions/2026-09-29-host-ui-primitives-compat.md) — UI 原子兼容 DSH 0.2.0-rc.2 的图标描边后缀命名
- [`2026-09-30-session-format-v4-producer-source.md`](../decisions/2026-09-30-session-format-v4-producer-source.md) — 会话消息 source 适配 format v4 的 producer-owned kind
- [`2026-09-30-session-open-face-compat.md`](../decisions/2026-09-30-session-open-face-compat.md) — 会话打开面的 uiWorkspace 兼容（修复 `ctx.sessions.open is not a function`）
- [`2026-10-05-import-turn-boundaries-and-settlement.md`](../decisions/2026-10-05-import-turn-boundaries-and-settlement.md) — 导入历史写成真实 turn 边界 + assistant 结算契约，修复 0.2.0-rc.2 会话损坏
- [`2026-10-05-v0-session-turn-repair.md`](../decisions/2026-10-05-v0-session-turn-repair.md) — v0 会话工件的 turn 坐标修复（history 加载失败闭环）
- [`2026-10-08-protected-surface-head.md`](../decisions/2026-10-08-protected-surface-head.md) — v4 受保护 surface 头：导入防写 + 存量修复
- [`2026-10-11-confirmable-session-writes.md`](../decisions/2026-10-11-confirmable-session-writes.md) — D-2 Confirmable Session Writes：宿主侧「必须成立」写入的读回验证
- [`2026-10-18-dsh-021-rc2-compat.md`](../decisions/2026-10-18-dsh-021-rc2-compat.md) — DSH 0.2.1-rc.2 深度适配：bind 全 seam 审计、子代理双 API、无工具推理 preset、client 原子表与 JSONL 持久化装载

### AgentTavern 与预设投影

- [`2026-09-10-deduce-prefix-cache-reuse.md`](../decisions/2026-09-10-deduce-prefix-cache-reuse.md) — 推演子 Agent 的前缀级复用（缓存成本优化）
- [`2026-09-10-subagent-deduction.md`](../decisions/2026-09-10-subagent-deduction.md) — 基于 SubAgent seam 的多 Agent 推演工具（`tavern_deduce`）
- [`2026-10-09-agent-preset-cache-stability.md`](../decisions/2026-10-09-agent-preset-cache-stability.md) — 预设投影的前缀缓存稳定性（冻结投影）
- [`2026-10-09-agent-tavern-preset-projection.md`](../decisions/2026-10-09-agent-tavern-preset-projection.md) — AgentTavern 预设投影（提示词块 + `temperature`）
- [`2026-10-11-agent-tavern-host-fork.md`](../decisions/2026-10-11-agent-tavern-host-fork.md) — AgentTavern 收养宿主原生会话分叉（fork adoption）
- [`2026-10-28-agent-tavern-body-plugin-records.md`](../decisions/2026-10-28-agent-tavern-body-plugin-records.md) — 正文状态持久化采用实验 plugin record（版本门控 + 政策披露）
- [`2026-10-28-agent-tavern-body-write-rollback.md`](../decisions/2026-10-28-agent-tavern-body-write-rollback.md) — 正文重生成的写入回滚：MVU receipt、记忆/变量 journal 与失败恢复时序
- [`2026-10-28-agent-tavern-mvu-body-edit.md`](../decisions/2026-10-28-agent-tavern-mvu-body-edit.md) — MVU 正文编辑 P0：候选级 receipt、惰性迁移与插件侧预检
- [`2026-10-28-agent-tavern-invisible-body-restore.md`](../decisions/2026-10-28-agent-tavern-invisible-body-restore.md) — 正文恢复 surface 方案：失败不再追加 assistant 副本
- [`2026-10-29-body-late-failure-and-turn-end.md`](../decisions/2026-10-29-body-late-failure-and-turn-end.md) — 正文回滚晚失败保留新正文 + live turn/end 自动恢复
- [`2026-10-29-body-prepare-crash-window.md`](../decisions/2026-10-29-body-prepare-crash-window.md) — 正文重生成 prepare → op-start 崩溃窗口：先落 plan 再动账
- [`2026-10-29-settle-crash-consistency.md`](../decisions/2026-10-29-settle-crash-consistency.md) — settle 跨 store 崩溃一致性：durable settle intent + 启动恢复
- [`2026-10-29-body-partial-hide-recovery.md`](../decisions/2026-10-29-body-partial-hide-recovery.md) — 正文结算部分 hide 收口：hide targets + finish-hide
- [`2026-10-29-imported-body-floor-adoption.md`](../decisions/2026-10-29-imported-body-floor-adoption.md) — 导入楼层接管：history mirror 首楼绑定 bodyGroupId + 客户端 projection-pending 重试
- [`2026-10-29-agent-tavern-regenerate-hides-draft.md`](../decisions/2026-10-29-agent-tavern-regenerate-hides-draft.md) — 重生成开始即隐藏旧正文：重掷不再看到草稿，失败恢复改为追加副本
- [`2026-10-29-body-read-freshness-and-group-cache.md`](../decisions/2026-10-29-body-read-freshness-and-group-cache.md) — 正文读侧：候选切换按组失效缓存 + 楼层落后时 ledger 文本优先

### AgentNovel

- [`2026-10-09-novel-claim-release.md`](../decisions/2026-10-09-novel-claim-release.md) — 认领释放路径（`novel_unit_release`）与跨 turn 认领的恢复通知
- [`2026-10-20-novel-import-revision.md`](../decisions/2026-10-20-novel-import-revision.md) — 原作导入续写（章节切分/逐部分提取/bible 熔炼）与正文优化（待应用版本）落地

### 记忆与变量

- [`2026-10-09-mvu-receipt-tri-state.md`](../decisions/2026-10-09-mvu-receipt-tri-state.md) — MVU 回执状态收窄为三态
- [`2026-10-11-cjk-tokenization.md`](../decisions/2026-10-11-cjk-tokenization.md) — B-1 中文分词修复记忆检索（CJK-aware tokenization）
- [`2026-10-11-memory-maintenance.md`](../decisions/2026-10-11-memory-maintenance.md) — B-3 记忆维护 Agent：chat 作用域记忆的自动纠错/合并/去错 run
- [`2026-10-11-mvu-receipt-undo.md`](../decisions/2026-10-11-mvu-receipt-undo.md) — MVU 回执撤销（B-6a）
- [`2026-10-11-mvu-rules.md`](../decisions/2026-10-11-mvu-rules.md) — MVU `$rules` 条件规则引擎（C-2）
- [`2026-10-11-mvu-schema-guard.md`](../decisions/2026-10-11-mvu-schema-guard.md) — MVU `$schema` 变量写入守卫
- [`2026-10-11-retrieval-eval-matrix.md`](../decisions/2026-10-11-retrieval-eval-matrix.md) — B-5a 受控中文记忆检索评测矩阵（确定性基线与回归门槛）

### 卡片工作台

- [`2026-10-08-card-full-editing.md`](../decisions/2026-10-08-card-full-editing.md) — 写卡 Agent 角色卡编辑能力完整扩展
- [`2026-10-08-worldbook-full-editing.md`](../decisions/2026-10-08-worldbook-full-editing.md) — 写卡 Agent 世界书编辑创建能力完整扩展
- [`2026-10-08-worldbook-plan-protocol.md`](../decisions/2026-10-08-worldbook-plan-protocol.md) — 世界书面板化方案协议（plan 协议接入工作台面板）
- [`2026-10-08-workbench-blank-reuse.md`](../decisions/2026-10-08-workbench-blank-reuse.md) — 写卡工作台会话补占位：摘除宿主 blank 复用资格
- [`2026-10-08-workbench-workspace.md`](../decisions/2026-10-08-workbench-workspace.md) — 写卡工作台使用专用内部 DSH 工作区
- [`2026-10-09-workbench-novel-preset-projection.md`](../decisions/2026-10-09-workbench-novel-preset-projection.md) — 写卡工作台 / AgentNovel 接入激活预设投影（带启用开关）
- [`2026-10-09-workbench-script-tools-cut.md`](../decisions/2026-10-09-workbench-script-tools-cut.md) — 写卡工作台剧本编辑工具（`script_get`/`script_put`）裁剪
- [`2026-10-09-workbench-session-rename.md`](../decisions/2026-10-09-workbench-session-rename.md) — 写卡会话侧边栏改名/删除
- [`2026-10-11-preview-generation.md`](../decisions/2026-10-11-preview-generation.md) — 试写预览：生成不入楼（D-4）
- [`2026-10-11-workbench-reference-read.md`](../decisions/2026-10-11-workbench-reference-read.md) — 写卡工作台读参考文件：挂宿主默认文件工具行（v2）
- [`2026-10-24-workbench-workspace-heal.md`](../decisions/2026-10-24-workbench-workspace-heal.md) — 写卡工作台内部工作区在每条入口都要能创建

### 剧本游玩

- [`2026-10-09-script-injection-window.md`](../decisions/2026-10-09-script-injection-window.md) — 剧本注入窗口不含上一块

### 交互与消息面

- [`2026-08-16-frontend-html-runtime.md`](../decisions/2026-08-16-frontend-html-runtime.md) — 消息中的 HTML/JS 前端使用隔离 iframe 运行
- [`2026-10-10-group-nudge-and-regex-slash.md`](../decisions/2026-10-10-group-nudge-and-regex-slash.md) — 群聊 nudge 装配接线与 STscript `/regex` 命令（`SLASH_COMMAND` 应用点）
- [`2026-10-11-prompt-viewer.md`](../decisions/2026-10-11-prompt-viewer.md) — 提示词查看器 + 世界书激活追踪（A-6）
- [`2026-10-11-agent-prompt-viewer.md`](../decisions/2026-10-11-agent-prompt-viewer.md) — 提示词查看器 Agent 模式预注入面
- [`2026-10-11-st-reasoning-stream.md`](../decisions/2026-10-11-st-reasoning-stream.md) — ST 思考 + 正文双通道流式显示
- [`2026-10-11-iframe-viewport.md`](../decisions/2026-10-11-iframe-viewport.md) — iframe 视口正确性 + 高度上报健壮性（A-4）
- [`2026-10-20-frontend-sidebar.md`](../decisions/2026-10-20-frontend-sidebar.md) — AgentTavern 会话的美化前端改由 DSH 原生右侧栏展示（最新一条楼层）
- [`2026-10-20-frontend-helper-compat.md`](../decisions/2026-10-20-frontend-helper-compat.md) — 美化前端右栏自动展开开关 + 酒馆助手（Tavern-Helper）兼容层（沙箱内 RPC 代理）
- [`2026-10-21-jsr-mvu-agent-frontend-compat.md`](../decisions/2026-10-21-jsr-mvu-agent-frontend-compat.md) — JSR/MagVarUpdate 卡在 Agent 模式的变量闭环、卡内 EJS 注入与前端 facade（含 MVU-ZOD 兼容卡实测）
- [`2026-10-21-frontend-host-background.md`](../decisions/2026-10-21-frontend-host-background.md) — 美化前端未设置背景时用 DSH 原生背景色填充画布（深色模式无白圈）
- [`2026-10-21-card-scripts-host.md`](../decisions/2026-10-21-card-scripts-host.md) — 卡脚本右栏（手动运行、不自动执行）、会话世界书副本、GM 面板 document facade 与行动栏画布/按钮修复
- [`2026-10-22-jsr-storage-packages.md`](../decisions/2026-10-22-jsr-storage-packages.md) — JSR 兼容运行时与沙箱虚拟存储拆分为独立库包（`tavern-jsr` / `tavern-frontend-storage`）
- [`2026-10-22-card-scoped-regex-and-worlds.md`](../decisions/2026-10-22-card-scoped-regex-and-worlds.md) — 卡级/预设级正则与世界书跟随来源自动启用/停用（手动勾选不被插件改写）
- [`2026-10-23-scoped-regex-identity-and-world-toggle.md`](../decisions/2026-10-23-scoped-regex-identity-and-world-toggle.md) — 同名正则按来源拆分实体（识别修复）、面板开关可切换并可转全局、链接世界书显示实际启停
- [`2026-10-23-scoped-regex-content-repair.md`](../decisions/2026-10-23-scoped-regex-content-repair.md) — 同名正则内容归属错位：按名认领要求内容一致 + v3 迁移修复已错位实体
- [`2026-10-23-regex-source-groups-and-bulk-delete.md`](../decisions/2026-10-23-regex-source-groups-and-bulk-delete.md) — 正则列表按全局/角色卡/预设分区，并在分区头提供整段清空
- [`2026-10-23-regex-group-master-toggle.md`](../decisions/2026-10-23-regex-group-master-toggle.md) — 正则分区头三态总开关：一键启停该来源的全部脚本
- [`2026-10-23-regex-group-folding.md`](../decisions/2026-10-23-regex-group-folding.md) — 正则分区按段折叠：默认收起，段头保留启停/条数/清空，过滤与编辑态强制展开
- [`2026-10-23-regex-card-order.md`](../decisions/2026-10-23-regex-card-order.md) — 卡级正则按卡内数组顺序应用，修复导入顺序打乱后警告脚本抢跑、状态栏误报「遗漏变量更新」
- [`2026-10-23-jsr-surface-parity.md`](../decisions/2026-10-23-jsr-surface-parity.md) — JSR 4.11 兼容面补齐：179 个公共名、同步变量/正则契约、脚本容器、预设/人设/世界书条目会话级覆盖
- [`2026-10-24-jsr-p0-p1-generation-events-storage.md`](../decisions/2026-10-24-jsr-p0-p1-generation-events-storage.md) — JSR P0/P1：流式生成与停止、事件补齐、`/regenerate`/`/stop`、跨 iframe 事件、IndexedDB index/cursor、设置/音频持久化
- [`2026-10-25-deleted-card-regex-cleanup.md`](../decisions/2026-10-25-deleted-card-regex-cleanup.md) — 删除角色卡时清理其卡级正则，并自愈历史孤儿归属脚本（同名新卡不再继承旧脚本）

### 面板与视图

- [`2026-08-14-composer-model-selection.md`](../decisions/2026-08-14-composer-model-selection.md) — Composer 模型选择：按 session 持久化 + 自建目录端点
- [`2026-08-15-locale-following-i18n-and-version-stamp.md`](../decisions/2026-08-15-locale-following-i18n-and-version-stamp.md) — UI 跟随 DSH 语言（zh/en）+ 设置页版本/commit 戳
- [`2026-08-15-tavern-management-panel.md`](../decisions/2026-08-15-tavern-management-panel.md) — Tavern 管理面板的入口选型与落地形态
- [`2026-10-08-store-change-polling.md`](../decisions/2026-10-08-store-change-polling.md) — 面板用 store 变更水位轮询吸收后台写入
- [`2026-10-09-panel-create-world-preset.md`](../decisions/2026-10-09-panel-create-world-preset.md) — 面板新建世界书与新建预设
- [`2026-10-09-panel-regex-script-editing.md`](../decisions/2026-10-09-panel-regex-script-editing.md) — 面板正则脚本新建与编辑
- [`2026-10-20-card-regex-backfill.md`](../decisions/2026-10-20-card-regex-backfill.md) — 存量角色卡正则脚本回填（面板「从角色卡同步」）
- [`2026-10-20-preset-regex-import.md`](../decisions/2026-10-20-preset-regex-import.md) — 预设内嵌正则脚本的导入期物化与存量回填（面板「从预设同步」）
- [`2026-10-09-panel-world-entry-counts.md`](../decisions/2026-10-09-panel-world-entry-counts.md) — 面板世界书列表预显条目数
- [`2026-10-10-sidebar-section-collapse.md`](../decisions/2026-10-10-sidebar-section-collapse.md) — 侧边栏酒馆/写卡工作台分区可折叠
- [`2026-10-14-panel-nav-fixed-brand-and-gamepad-icon.md`](../decisions/2026-10-14-panel-nav-fixed-brand-and-gamepad-icon.md) — 面板导航列「标题区固定」+ 游戏图标手柄化
- [`2026-10-14-panel-mobile-navlist-strip-regression.md`](../decisions/2026-10-14-panel-mobile-navlist-strip-regression.md) — 移动端横向按钮条回归：导航清单容器在 700px 断点里的退场
- [`2026-10-16-sidebar-region-scroll-and-workbench-collapsed.md`](../decisions/2026-10-16-sidebar-region-scroll-and-workbench-collapsed.md) — 侧栏两分区固定高度 + 独占滚动，写卡工作台默认收起
- [`2026-10-16-soulmojito-brand-mark.md`](../decisions/2026-10-16-soulmojito-brand-mark.md) — 品牌 logo 落四面：面板标题区 + 侧栏按钮 + 设置页入口 + 面板「关于」分区
- [`2026-10-21-behavior-settings-section.md`](../decisions/2026-10-21-behavior-settings-section.md) — 面板「行为设置」分区：散养行为开关收编，按行为对应关系分组
- [`2026-10-23-panel-mobile-group-strip.md`](../decisions/2026-10-23-panel-mobile-group-strip.md) — 移动端标题区挤压：分组容器在 700px 断点里退场 + 活动分区 chip 入视

### Mod 扩展

- [`2026-10-10-mod-p0-hook-buses.md`](../decisions/2026-10-10-mod-p0-hook-buses.md) — Mod P0：五条注册表/总线骨架（纯重构零行为变化）
- [`2026-10-10-mod-p1-loader.md`](../decisions/2026-10-10-mod-p1-loader.md) — Mod P1：加载器与最小可用（manifest 校验、三层开关、api 适配层、审计线）
- [`2026-10-10-mod-p2-capabilities.md`](../decisions/2026-10-10-mod-p2-capabilities.md) — Mod P2：能力面扩展（hooks/tools/macros/stscript/llm/prompt + iframe 表面 + git 安装）
- [`2026-10-10-mod-review-fixes.md`](../decisions/2026-10-10-mod-review-fixes.md) — 主会话两轴审查的修复落地（Mod P0-P2 交付后）
- [`2026-10-11-mod-bridge-buttons-logs.md`](../decisions/2026-10-11-mod-bridge-buttons-logs.md) — Mod 桥下行事件 + 声明式按钮 + 日志查看器（A-1 / A-2）
- [`2026-10-11-mod-stream-delta.md`](../decisions/2026-10-11-mod-stream-delta.md) — Mod 流式 token 事件（A-3）
- [`2026-10-12-story-clock-engines-drift.md`](../decisions/2026-10-12-story-clock-engines-drift.md) — Story Clock 示例 Mod 被 engines 卡死：0.x caret 次段锁 + 测试版本漂移共谋

### 游戏桥与内置游戏

- [`2026-10-13-agent-game-bridge.md`](../decisions/2026-10-13-agent-game-bridge.md) — Agent 游戏桥 P0–P3 落地（提案 0018 实施）
- [`2026-10-14-gomoku-builtin.md`](../decisions/2026-10-14-gomoku-builtin.md) — 内置五子棋（提案 0018 §4.1 双内置回归）
- [`2026-10-14-xiangqi-builtin.md`](../decisions/2026-10-14-xiangqi-builtin.md) — 内置中国象棋（内置序列第三款）
- [`2026-10-14-junqi-builtin.md`](../decisions/2026-10-14-junqi-builtin.md) — 内置军棋（内置序列第四款）
- [`2026-10-14-blackjack-builtin.md`](../decisions/2026-10-14-blackjack-builtin.md) — 内置 21 点（内置序列第五款）
- [`2026-10-15-memory-match-builtin.md`](../decisions/2026-10-15-memory-match-builtin.md) — 内置记忆翻牌对战（内置序列第六款）
- [`2026-10-15-monopoly-builtin.md`](../decisions/2026-10-15-monopoly-builtin.md) — 内置大富翁（内置序列第七款）
- [`2026-10-16-dungeon-crawl-builtin.md`](../decisions/2026-10-16-dungeon-crawl-builtin.md) — 内置地牢爬行（内置序列第八款，品类扩展第一款）
- [`2026-10-17-chinese-checkers-builtin.md`](../decisions/2026-10-17-chinese-checkers-builtin.md) — 内置中国跳棋（内置序列第九款）
- [`2026-10-17-games-panel-import.md`](../decisions/2026-10-17-games-panel-import.md) — 面板「游戏」导入入口（zip 上传 + git 安装）与标准游戏包制作指南
- [`2026-10-14-games-autowake.md`](../decisions/2026-10-14-games-autowake.md) — 人类落子自动续弈：Agent 未 wait 时的插件侧唤起（§15）
- [`2026-10-15-games-wake-turn-gates.md`](../decisions/2026-10-15-games-wake-turn-gates.md) — 自动续弈的回合闸与运行中闸：决定窗提前唤醒与陈旧通知的竞态修复（§21）
- [`2026-10-14-games-delta-tools.md`](../decisions/2026-10-14-games-delta-tools.md) — 游戏工具面 token 经济修订：wait/move 只回更新，读取面独立
- [`2026-10-16-games-wait-full.md`](../decisions/2026-10-16-games-wait-full.md) — `game_wait_full`：带棋盘视图的等待变体（工具面第七件）
- [`2026-10-14-games-resign-policy.md`](../decisions/2026-10-14-games-resign-policy.md) — 禁用投降 + 用户投降按钮 + 终局保留盘面（§16）
- [`2026-10-14-xiangqi-check-prompts.md`](../decisions/2026-10-14-xiangqi-check-prompts.md) — 象棋将军提示层（§17）
- [`2026-10-14-blackjack-seat-ownership-view.md`](../decisions/2026-10-14-blackjack-seat-ownership-view.md) — 21 点视图坐席归属修复（用户坐庄 · 庄家/玩家显示反转）
- [`2026-10-14-quoted-coordinate-tolerance.md`](../decisions/2026-10-14-quoted-coordinate-tolerance.md) — 工具坐标容错：整数字符串归一（实弹对局停摆修复）

### 自更新与发布

- [`2026-10-05-desktop-plugin-self-update.md`](../decisions/2026-10-05-desktop-plugin-self-update.md) — 桌面版内置自更新（GitHub 版本发现、落地路径顺序、curl 兜底、构建期 stamp）
- [`2026-10-12-update-restart-required-stuck.md`](../decisions/2026-10-12-update-restart-required-stuck.md) — 「需要重启」永不解除：stamp 自指悖论 + 共享缓存幽灵
- [`2026-10-14-update-checkout-shipped-files-drift.md`](../decisions/2026-10-14-update-checkout-shipped-files-drift.md) — 自更新 checkout 兜底：发布清单单一事实来源化（SHIPPED 漂移修复）
- [`2026-10-16-project-rename-dsh-soulmojito.md`](../decisions/2026-10-16-project-rename-dsh-soulmojito.md) — 项目改名：dsh-tavern → DSH-SoulMojito（全仓标识符映射与读取双认兼容层）
- [`2026-10-21-storage-dir-soulmojito.md`](../decisions/2026-10-21-storage-dir-soulmojito.md) — 存储目录迁移：`$DSH_HOME/tavern` → `soulmojito`（旧目录原地兼容，不自动搬迁）

### 资产与格式

- [`2026-08-14-card-raw-passthrough.md`](../decisions/2026-08-14-card-raw-passthrough.md) — 角色卡 IR 的 raw 袋必须存整个顶层对象（含 V1 兼容字段）
- [`2026-10-08-default-avatar-fallback.md`](../decisions/2026-10-08-default-avatar-fallback.md) — 无头像资产的默认替代头像

### 工程实践

- [`2026-10-09-dedup-refactor.md`](../decisions/2026-10-09-dedup-refactor.md) — 审查修复的七项去重/拆分重构

## 探索（`exploration/`）

调研归档，结论必须带证据坐标（文件:行号）。

- [`2026-08-14-st-formats.md`](exploration/2026-08-14-st-formats.md) — SillyTavern 互操作格式与行为参考
- [`2026-08-14-fabric-architecture.md`](exploration/2026-08-14-fabric-architecture.md) — Fabric 调研与后备定位（不在第一版运行路径中）
- [`2026-08-16-dsh-agentloop-native-audit.md`](exploration/2026-08-16-dsh-agentloop-native-audit.md) — DSH AgentLoop 原生注入、compaction 与 Fabric fallback 审计（`agent-managed` 保持关闭的依据）
- [`2026-10-11-jsr-lwb-reference.md`](exploration/2026-10-11-jsr-lwb-reference.md) — JS-Slash-Runner 与 LittleWhiteBox 竞品参考与不复刻清单

## 计划与记录

- [`plans/2026-08-15-tavern-panel-implementation.md`](plans/2026-08-15-tavern-panel-implementation.md) — Tavern 面板施工计划
- [`plans/2026-08-16-agent-tavern-implementation.md`](plans/2026-08-16-agent-tavern-implementation.md) — AgentTavern 分阶段施工计划、宿主门禁、迁移规则与验证矩阵
- [`adr/0001-agenttavern-native-agentloop.md`](adr/0001-agenttavern-native-agentloop.md) — ADR：AgentTavern 复用原生 AgentLoop

## 开发者文档

- [`mods/mod-api.md`](mods/mod-api.md) — Mod 扩展开发者文档（清单、生命周期、全部能力面、面板 UI 表面协议、管理端点与审计）
- [`games/game-package.md`](games/game-package.md) — 标准游戏包制作指南（三件套、引擎契约、视图桥协议、打包/导入、校验排错）

## 示例

- [`packages/plugin/examples/mods/`](../packages/plugin/examples/mods/) — 四个官方示例 Mod（asset-stats / mood-tracker / story-clock / rps），覆盖 Mod v1 全部能力面。
- [`packages/plugin/examples/games/dsh-soulmojito.gomoku/`](../packages/plugin/examples/games/dsh-soulmojito.gomoku/) — 游戏桥标准的参照实现（`game.json` 清单 + 零依赖纯函数 `engine.mjs` + 自包含 `view.html`）。该游戏另有内置实现，本包保留为**导入路径参照**与可分发样本；同 id 导入时以磁盘副本接管槽位。如何制作自己的游戏包见 [`games/game-package.md`](games/game-package.md)。
- [`packages/plugin/README.md`](../packages/plugin/README.md) — 插件包自身的安装与包级说明。
