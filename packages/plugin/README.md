# dsh-tavern 插件包

该目录是可安装的 DSH 官方 Web bundle。仓库根的 `pnpm run build:plugin` 会把五个 workspace 纯库和 Node half 打入单一 `index.mjs`。client closure 由 DSH profile 注入，不要求用户另行安装公共 `@deepseek-ai/*` 依赖。

## 安装

```sh
pnpm run build:plugin
dsh plugin --profile web add ./packages/plugin
dsh --profile web
```

安装后：

- 侧边栏底部、紧挨设置按钮的 **Tavern 按钮**（rail 模式为圆形图标钮）打开「Tavern 管理面板」——与原生设置同构的模态面板（左侧导航 + 右侧内容），复用 DSH 的 Modal/Button/Input/Pill/StateDot 原语与 `--dsw-alias-*` 设计 token。面板十个分区：总览（活跃配置 + 资产计数）、角色（卡片网格、完整卡查看、设为活跃、导出、删除）、聊天（按角色/群组浏览、新建/重命名/删除/打开）、群组、用户人设、世界书（激活开关 + 条目浏览器 + 搜索）、预设（kind 标签、设为活跃、删除）、正则脚本、变量（全局 STscript 变量编辑 + 当前会话局部变量查看）、生成（管线模式 + Kobold 端点 + StateDot 连接状态）。
- “设置 -> dsh-tavern”保留快速切换（角色/预设/persona）与「打开酒馆面板」入口，世界书激活开关在管理面板「世界书」分区管理；设置页标题下显示插件版本号与 commit 号。构建会生成不纳入 Git 的 `version.json` 旁车文件；源码检出运行时优先读取 Git HEAD，脱离 `.git` 的发布包读取该文件中的 commit，必要时可用 `DSH_TAVERN_COMMIT` 兜底。
- ST 聊天在原生 `Tavern` tab 使用 Tavern transcript、composer、Stop、edit、swipe 和 regenerate；AgentTavern/native 聊天使用 DSH 原生 conversation、composer、Stop、错误处理和统计。
- 设置页可选择在新 AgentTavern 会话初始化时一次性预载角色信息和常驻世界书条目。开关默认关闭，只影响之后新建的 AgentTavern 会话，不会在每次模型请求时重复注入，也不追溯修改已有会话。
- 助手消息中的完整 HTML 文档、`<head>`/`<body>` 片段，或 `html` Markdown 代码块会在 `sandbox="allow-scripts"` iframe 中运行；源码不会直接插入宿主页面。

前端代码只要包含 `<!doctype html>`，或包含 `<html>` 与 `<head>`/`<body>`，或直接包含 `<head>`/`<body>` 即可识别；
body-only 片段会自动补齐文档外壳。流式生成阶段不会执行半成品脚本，消息保存后才挂载 iframe；普通 Markdown/代码块保持文本显示。

iframe 不授予 `allow-same-origin`，因此脚本不能读取或操作宿主 DOM、Cookie、`window.parent`、`TavernHelper` 或 DSH API（高度回传仅使用受校验的 `postMessage`）。
CSP 允许内联 CSS/JavaScript，以及 `cdn.jsdelivr.net`、`testingcf.jsdelivr.net`、`cdn.tailwindcss.com`、
`cdnjs.cloudflare.com`、`unpkg.com`、`esm.sh`、`fonts.googleapis.com`、`fonts.gstatic.com` 的静态资源；
`fetch`/XHR/WebSocket、嵌套 iframe、插件对象和表单提交均被禁止。图片、字体和媒体仍可使用 `https:`、`data:` 或 `blob:` URL。
高度会自动同步并限制在 80-1200px，TUI/headless 只显示原始消息文本。

安装并重启 DSH 后，在 Tavern 聊天中发送一个完整 HTML 或 `html` 代码块即可验证前端运行能力。

聊天文件保存在 `$DSH_HOME/tavern/chats/`，并使用 revision compare-and-swap 防止跨标签页静默覆盖。删除角色会连同其聊天记录一并移除（对齐 ST 语义），并自动收敛群组成员与失效会话绑定。

ST 与 AgentTavern 共用 DSH 中的 `Tavern (internal)` 专用工作区。插件首次新建聊天时会创建 `$DSH_HOME/tavern/workspace/` 目录并幂等注册该工作区；新会话不会再进入当前或最近使用的原生工作区，Agent 的工作区工具也不会直接落到角色卡和聊天数据根目录。该内部工作区由插件从原生侧边栏会话树隐藏，识别以注册路径和 workspace ID 为准；旧版宿主没有暴露身份属性时，仅在显示名全局唯一的情况下按标题回退，卸载插件会恢复原 DOM。升级前已经创建的宿主会话因 DSH 的工作目录不可变而保留原归属。

## AgentTavern 当前状态

| 架构 / 模式 | 状态 | 行为 |
|---|---|---|
| `agent-tavern` + `dsh-native` | rc.6 可用，单角色新聊天默认启用 | 使用 DSH 原生 AgentLoop；Tavern 只提供角色资产、聊天投影和作用域工具。 |
| `agent-tavern` + `agent-managed` | rc.6 不可用 | 宿主缺少 `agent/context` 和 projection-aware compaction，设置项禁用，服务端拒绝，不伪造主动遗忘。 |
| `st` | 可用 | 保留原有 Tavern `/generate`、swipe、regenerate、STscript 和 Text Completion 路径。 |
| 群聊 | 固定 `st` | 在宿主提供 actor 元数据前，不启用群聊 AgentTavern。 |

当前 AgentTavern 工具只从真实 session binding 推导身份，不接受模型传入的 `sessionId` 或 `scopeId`：

| 工具 | 作用 |
|---|---|
| `tavern_character_get` | 当前角色卡摘要、场景字段和卡片版本。 |
| `tavern_lore_search` | 按查询词和预算检索全局启用、角色关联及卡内嵌世界书。 |
| `tavern_scene_get` | 当前聊天的场景、消息数量和 metadata。 |
| `memory_search` | chat、character、agent 作用域的有来源词法检索。 |
| `memory_write` | 带来源、标签、revision 和大小限制的记忆写入。 |
| `variable_get` | 读取作用域内 typed JSON 变量。 |
| `variable_set` | 写入变量并支持 expected revision CAS。 |
| `tavern_deduce` | 基于 SubAgent 的多角色推演：为 2-5 个命名角色各派生一个纯推理子 Agent，按 1-3 轮交叉站位，返回各轮位置由主 Agent 叙述。 |

AgentTavern 的原生 user/final assistant 事件会幂等投影到 Tavern JSONL；tool、chunk 和 reasoning 事件不会伪装成 Tavern 消息。缺少宿主能力时，插件保持 native 或 ST 的明确边界，不把 compaction 误称为 managed context。

## 多Agent推演（tavern_deduce）

新版 DSH（0.1.2+）提供 SubAgent capability seam（`ctx.subagents`）与 in-process `spawn` 驱动。`tavern_deduce` 在此之上实现沙盘推演：调用方（RP 主 Agent）从剧情中归纳 2-5 个有利害冲突的角色（关键人物、阵营或全知视角），本工具为每个角色派生一个一次性子 Agent——spawn 语义不带父会话上下文，`toolFilter: { allow: [] }` 清空工具保持纯推理，`finally` 中 dispose 保证零泄漏。第 2 轮起每个角色的 prompt 携带此前各轮的全员站位，形成交叉推演（对峙、让步、反制）；transcript 由本工具无状态维护，不依赖 continuable 持久化。

边界与失败语义：

- 单角色失败（非 `completed` 或空输出）只进 `failures` 数组，不阻断其余角色；全员失败才抛错。
- 推演结论不由子 Agent 合成——工具只回传各轮 `positions`，由主 Agent 织入叙事，保持单一叙事声音。
- 仅 AgentTavern 绑定会话可用（复用 binding 门禁，群聊拒绝）；未部署 dsh-subagent 的宿主上明确报错，而不是静默降级。

## Compaction curator

`dsh-native` 模式下历史容量由宿主 `dsh-compaction-basic` 决定，而它的自动摘要是编码助手导向的（Files and Code / Pending Jobs 等段落），会把剧情状态、人物关系和记忆维护习惯摘要掉。本插件的 bundle patch 因此把 `compaction-basic` 一行覆写为 `dsh-tavern/compaction`：该引擎继承宿主 basic 实现，触发时机、保留预算、overflow recovery 与工具结果修剪全部复用宿主，仅覆写摘要指令——

- **AgentTavern 绑定的会话**使用 RP 检查点模板（Story So Far / Characters / World Canon / Open Threads / Current Scene / Memory Maintenance / Critical Context），其中 Memory Maintenance 段显式记录记忆工具的维护状态，使 KERNEL 的记忆职责跨 compaction 延续；摘要语言跟随对话。
- **其余会话**（编码等）原样透传宿主默认摘要，零影响。
- 可选 curator 专属配置（其余配置键与 basic 完全一致）：`curatorProvider` / `curatorModel` 为 RP 摘要指定独立模型（缺省跟随当前路由），`curatorMaxTokens` 覆盖摘要输出上限（缺省 8192）。在 profile 的 `cordis.patch.yml` 给 `id: compaction-basic` 行加 `config` 即可。

回退：在 profile `cordis.patch.yml` 写 `- id: compaction-basic` + `name: '@deepseek-ai/dsh-compaction-basic'` 覆写回去。摘要调用与宿主默认 summarizer 同为 logged 的 `ctx.llm.stream` 辅助调用，`;compact` 手动命令与自动 compaction 共用该后端。

## 锚定提醒（anchor：开场装载引导 + 周期锚定）

工具调用衰减有两个实证窗口，本插件通过宿主 `agent/pre-step` 在批次末尾（注意力最高点）追加提醒（与宿主 `dsh-time-context` 同款追加模式）：

- **开场不装载**：29f49b5 起开场白与既有聊天历史会镜像进原生会话，模型把镜像剧情当作"本聊天已确立的事实"，KERNEL 的 established-in-this-chat 豁免条款反而抑制了开场查证，开场完全跳过工具。第一个真实用户轮（会话尚无 `source.kind === 'user'` 消息）注入一次性的开场装载引导（`tavern_character_get` / `tavern_lore_search` / `memory_search` / `tavern_history_search` 清单），不受轮数节流；其后由周期锚定接管。
- **长上下文衰减**：system prompt 里的 KERNEL 职责会被剧情文本稀释，模型在若干轮后停止主动写记忆/查世界书。默认每 5 个 turn 的 step 1 注入一次周期维护提醒，把职责重新拉回注意力。

共同契约：

- **触发**：仅 step 1；去重（同 turn 不重复，开场与周期共用去重账本）、空批次/拒绝/中止/非 AgentTavern 会话全部原样透传；存储读取只发生在注入点，非注入 step 零开销。
- **缓存安全契约**（不可破坏）：提醒 append-only 且 write-once——只追加到当前批次末尾、写入 durable log 后永不改写，因此对 KV 前缀缓存完全透明；内容不含易变计数器。
- **投影安全**：消息带 `dsh-tavern` plugin source，投影器按 `source.kind !== 'user'` 过滤，不会写进 Tavern JSONL 剧情记录。
- **配置**：`dsh-tavern` 行 config 的 `anchorEveryTurns`（整数；`0` 同时关闭开场引导与周期锚定，缺省 5，非法值回退默认）。

## 语言

插件 UI 跟随 DSH 的语言设置（`@deepseek-ai/dsh-client-locale`，zh/en）：client half 声明 `inject: [..., 'locale']`，向 locale 服务注册 `dsh-tavern` 命名空间字典并经 `useSyncExternalStore` 订阅快照，在“通用设置 -> 语言”切换后无需刷新即时生效。字典 zh/en 键集与 `{param}` 占位符的对称性由 `client-vm-mount` gate 校验。

## 验证

```sh
pnpm run build:plugin
node packages/plugin/scripts/gates/run.mjs
```

当前 gate 覆盖包元数据、Cordis patch、Node/client bundle、frontend runtime、client VM mount、Node half mount、AgentTavern 隔离、native header adapter、内部工作区、revision、stale binding 和设置页边界。完整仓库基线为 21 个测试文件、169 项测试。

## 插件管理

已安装插件建议使用 plugin-registry 的薄控制台管理 profile 中的 bundle 层栈、insert 行和启停状态，避免手改配置。将 `<plugin-registry>` 替换为该工具仓库的本地路径：

```sh
dsh plugin --profile web add <plugin-registry>/packages/plugin/console
```
