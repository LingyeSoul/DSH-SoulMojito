<h1 align="center">dsh-tavern</h1>

<p align="center">把 DSH（deepseek-harness）扩展成兼容 SillyTavern 生态的原生角色扮演工作区。</p>

## 当前状态

第一版主线已经可用：插件复用 DSH 的 LLM 路由、默认模型、密钥管理、Web 容器和插件安装机制，同时在 DSH 原生侧边栏和 conversation 区域提供 Tavern 角色扮演体验。管理入口是独立的 Tavern 面板；设置页保留当前配置的快速切换，不再承载全部资产管理表单。

在此之上，交互面提供持续指引、行动候选与带意见重写；资产面提供 MVU 变量结算回执、卡片工作台（对话改卡 + 确认协议）与剧本游玩；扩展面提供 Mod 扩展接口与官方示例（提案 0009-0015，均已实现）。

当前面向 DSH `0.2.0-rc.2` 验证。Fabric 不在第一版运行路径中。

## 能力

- Character Card V1/V2/V3：JSON、PNG `chara`/`ccv3`，以及 CHARX `card.json` 和 `embeded://` assets。
- World Info / Lorebook：递归扫描、副键逻辑、概率、预算、inclusion group、sticky/cooldown/delay 和位置分发。
- Chat Completion preset：`prompts[]`、`prompt_order[]`、marker 和采样参数。
- SillyTavern chat JSONL：header、messages、`swipes`、`swipe_id`、`swipe_info`。
- RP 交互：流式生成（思考与正文双通道：reasoning 增量实时流式显示、保存后可折叠回看，各 swipe 候选各自的思考随切换跟随）、Stop、消息编辑、swipe、regenerate、聊天创建、重命名和确认删除。ST 思考流式详见 [`decisions/2026-10-11-st-reasoning-stream.md`](decisions/2026-10-11-st-reasoning-stream.md)。
- 消息分支 / bookmark：任意消息一键分支为新聊天，`chat_metadata.bookmark_link` 回链，视图可跳回父聊天。
- 持续指引（Conversation Guides）：把长期生效的写作/节奏要求（如「多写心理活动」「好感度涨得慢一点」）保存为 Guide，本局正文、行动候选与带意见重写自动参考；上限 8 条、单条 ≤500 字符，面板增删、删除即时生效，正文中不回显。AgentTavern 会话以 systemPrompt context 段注入。详见 [`docs/proposals/0009-conversation-guides.md`](docs/proposals/0009-conversation-guides.md)。
- 行动候选（ST 聊天）：一键生成 3-6 个「人物行动 / 场景变化」候选，点击填入输入框（可改再发），或携带反馈重新生成；候选是建议不是指令，没有自动执行路径。详见 [`docs/proposals/0010-turn-candidates.md`](docs/proposals/0010-turn-candidates.md)。
- 带意见重写（ST 聊天）：对当前轮回复附一句修改意见（可留空等价普通 regenerate）后重写，结果作为新 swipe 追加，可左右切换比较；意见只存在于该次请求与 swipe 元数据，不落盘为聊天楼层。详见 [`docs/proposals/0011-rewrite-with-feedback.md`](docs/proposals/0011-rewrite-with-feedback.md)。
- Persona 管理：PNG 导入（内嵌描述提取）、头像、增删改、激活选择与 `position/depth/role` 注入。
- 群聊：成员管理、自然（talkativeness 加权）/列表激活策略、成员点触发言、`group_only_greetings`、group nudge 和 `{{group}}` 宏。
- 正则脚本：ST regex 扩展形态导入，全局 + 卡级合并，`USER_INPUT/AI_OUTPUT/WORLD_INFO/REASONING` placement、`minDepth/maxDepth`、`substituteRegex`、`trimStrings`。
- STscript：管道、变量（聊天局部 + 全局）、`/if` 条件、随机/掷骰和聊天动作（`/send`、`/trigger`、`/regenerate`、`/cut`），composer `/` 前缀触发。
- Prompt Template（EJS）：在预设、世界书、角色卡字段与消息中执行 `<% %>` JavaScript（`node:vm` 沙箱）；`getvar/setvar` 族带作用域变量（chat local 任意 JSON / `scriptGlobals` 全局 / InitialVariables 初值）；`[GENERATE:*]` / `[RENDER:*]` 内容注入、`@INJECT` 整消息插队、`[InitialVariables]` 变量树、`getwi/getchar/getpreset` 资产读取、`@@if`/`@@private` 装饰器与 `<#escape-ejs>` 保护块。详见 [`docs/proposals/0008-prompt-template.md`](docs/proposals/0008-prompt-template.md)。
- Composer 模型选择：复刻 DSH 原生 model seat 的 provider 分组目录与 Effort 二级菜单，按 session 持久化，未选择时回落 DSH 默认模型。
- 并发保护：聊天使用内容 revision 做 compare-and-swap；跨标签页冲突返回 `409`，客户端重新加载最新内容，不静默覆盖。
- 可选的普通 Agent 人格注入，默认关闭。
- AgentTavern 原生模式：单角色新聊天默认复用 DSH AgentLoop、原生 composer、Stop、错误处理和统计；角色、世界书、场景、记忆和变量通过会话级工具按需读取，原生事件幂等投影回 Tavern JSONL。宿主原生会话分叉自动收养：用 DSH 会话菜单的 fork、conversation 的任意轮尾分叉或 `sessions.fork` API 分叉一个 AgentTavern 会话，子会话首次运行时插件为其物化新 Tavern 聊天（` - fork N` 命名、`bookmark_link` 回链父聊天切点、guides 与 MVU 回执随 header 继承），拷贝 chat 作用域变量/记忆/向量，按父 contextMode 落绑定，并把继承前缀投影回填为新聊天楼层——工具面、上下文装配与锚定 cadence 从首轮起完整可用；subagent 子会话与 ST/AgentNovel/工作台会话的分叉不在收养面。激活预设同样生效：启用的内容型提示词按 `prompt_order` 顺序注入会话 system prompt（`main`/`jailbreak` 保留角色卡 `system_prompt`/`post_history_instructions` 覆盖语义），采样只投影 `temperature`；资产类 marker（角色卡字段、世界书、示例对话、历史）不重复固定注入，仍由工具、原生历史与可选预载承接。可选开关会在新 AgentTavern 会话初始化时一次性预载角色信息和常驻世界书条目，默认关闭且不追溯修改已有会话。现有 ST 兼容架构继续保留。分叉收养详见 [`decisions/2026-10-11-agent-tavern-host-fork.md`](decisions/2026-10-11-agent-tavern-host-fork.md)。
- AgentTavern managed 模式：保持关闭。该门禁的宿主能力审计基于 DSH `0.1.0-rc.6`（宿主尚未提供 `agent/context` 历史投影和 projection-aware compaction）；`0.2.0-rc.2` 已确认仍未提供该 seam。插件不会把普通 compaction 冒充为主动遗忘，也不会静默回退到伪 managed 模式。详见 [`docs/exploration/2026-08-16-dsh-agentloop-native-audit.md`](docs/exploration/2026-08-16-dsh-agentloop-native-audit.md)。
- MVU 变量结算：变量由后台按卡内规则做**确定性脚本结算**（与 flizzywine 的后台 LLM 结算是不同的架构选择，日常结算零额外模型开销），正文不再夹带状态栏。每轮产出变量回执（每项变更的前后值、原因、失败项），失败项可单独重试而不动正文；固定状态栏模板由变量渲染，不随流式生成掉格式。面板与状态栏在两个架构表面都可达：ST 挂在聊天视图顶部，AgentTavern 从会话标题栏按钮弹出；变量源按绑定架构取（ST 读 `chat_metadata.variables`，AgentTavern 聊天读 chat 作用域变量存储并覆盖回同一棵嵌套树），只有回执、没有变量落盘的失败轮同样可见。AgentTavern 侧提供 `tavern_variable_settle` 工具，ST 侧走同一结算语义与回执投影。变量树根可选 `$schema` 子树是**写入守卫**（结构/类型锁定、`$range`/`$step` 越界 clamp、`$enum` 枚举拒绝、`$ro` 只读、`"*"` 通配与数组项模板）：clamp 进正常回执（reason 标注 guard），违规进失败项可重试，无 `$schema` 的卡行为不变。变量树根还可选 `$rules` 子树声明**条件规则**（`when`/`then` 表达式，求值走模板沙箱、Date/random 等不确定性源遮蔽）：结算守卫之后做确定性二次计算（阈值触发、派生值、连锁修正，链式求值有 3 轮上限），变更 reason 标 `rule:<名字>` 进同一回执——v1 无编辑 UI，规则在卡 JSON 里手写。回执可**撤销**（newest-first 链，只能撤最新一条有效回执）：每项变更恢复到回执记录的 before 值（恢复值过守卫，被拒整次不动），已撤销回执灰显，两架构与面板按钮同权。详见 [`docs/proposals/0012-mvu-settlement.md`](docs/proposals/0012-mvu-settlement.md) 与 [`decisions/2026-10-11-mvu-schema-guard.md`](decisions/2026-10-11-mvu-schema-guard.md)、[`decisions/2026-10-11-mvu-receipt-undo.md`](decisions/2026-10-11-mvu-receipt-undo.md)、[`decisions/2026-10-11-mvu-rules.md`](decisions/2026-10-11-mvu-rules.md)。
- 卡片工作台：`dsh-tavern/card-workbench` agent preset。用对话描述想改什么，Agent 先给出方案，经确认面板（diff 视图）确认后才写入——写入工具必须携带已确认方案的 `planId`。支持修改人物卡/世界书/预设、空白建卡、从素材或剧本提取人物制卡、card-to-mvu 转换（写入固定状态栏模板与新聊天初始变量），以及把指定聊天连同楼层范围交给工作台排错。导入资产时写一次原版快照，随时可恢复原版。写卡 Agent 落盘后面板自动吸收：打开面板即重取最新资产，页面可见期间按 store 变更水位（3s）轮询，写入到列表可见不需手动刷新页面。面板「预设」分区的「预设生效范围」可让工作台（引用式，供起草卡面对齐风格与排错还原对局提示词环境）与小说推演（跟随式风格栈）接入激活预设堆栈，两者默认关闭。详见 [`docs/proposals/0013-card-workbench.md`](docs/proposals/0013-card-workbench.md)、[`decisions/2026-10-09-workbench-novel-preset-projection.md`](decisions/2026-10-09-workbench-novel-preset-projection.md)。
- 剧本游玩：TXT/Markdown/EPUB 小说、大纲或剧本导入为剧本资产，与人物卡一对一绑定，新开局自动按剧本推进；只按进度召回附近片段，不整本注入上下文。剧本块是参考不是约束：玩家随时可偏离，只有正文实际覆盖当前片段的关键事件才推进进度；右侧剧本卡实时显示进度（是进度展示，不是跳章按钮）。详见 [`docs/proposals/0014-script-play.md`](docs/proposals/0014-script-play.md)。
- 美化前端：助手消息中的完整 HTML 文档或 `html` 代码块会在隔离 iframe 中运行，支持内联 CSS、JavaScript 和常用 CDN 资源；普通文本与不完整流式内容仍按文本显示。
- Mod 扩展接口（提案 0015）：把带 `mod.json` 的目录放进 `$DSH_HOME/tavern/mods/`（或面板内 git 一键安装）即可被识别，默认禁用；首次启用弹确认层如实展示其声明的能力面（知情同意，含无沙箱告知）。启用后的 Mod 可注册：五相位生成 hook（user-input / pre-assemble / pre-llm / post-output / post-save，顺序 waterfall，抛错 / 超时 / 忘 return 统一降级、不中断生成）、Agent 工具（强制 `<modId>_` 前缀并与内置工具三层查重，冲突即拒）、宿主宏与 STscript 命令（确定性筛查，首错降级保原文）、prompt 分区（order 宿主钳制 -50..0 防冲核心位）、带配额的持久化存储（单值 256KB / 总量 1MB）、HTTP 子路由（`/api/dsh-tavern/mods/<id>/`，path 白名单拒穿越）与沙箱化面板 UI（`sandbox="allow-scripts"` iframe，无 same-origin，CSP `connect-src 'none'`，postMessage 数据桥）；llm 调用能力按 manifest 声明门控，用量进审计。坏 Mod 只记审计跳过、不拖垮本体；禁用 / 卸载全注册面回收，全部装载与调用行为落审计日志；`DSH_TAVERN_DISABLE_MODS` 可硬关整个 Mod 系统。开发者文档见 [`docs/mods/mod-api.md`](docs/mods/mod-api.md)，官方示例 asset-stats / mood-tracker / story-clock 覆盖 v1 全部能力面；Mod 还可声明按钮（manifest `buttons` → 面板与 ST 聊天视图渲染 chip，点击分发到 `api.onButton` handler）、接收本客户端写入的下行事件推送（聊天保存/资产保存/guides/按钮点击，`dsh-tavern:mod-event`），Mod UI 的 console 输出自动回投宿主的 per-mod 日志查看器（内存环形缓冲，`dsh-tavern:mod-log`）。
- 提示词查看器（A-6）：管理面板「提示词」分区查看 ST 生成循环每轮**实发给 LLM 的最终请求**（pre-llm 改写之后，看到即实发；system 段 / 消息序列 / 采样参数）与世界书激活轨迹（条目、命中键、位置、概率掷值、常驻/递归）；Agent 模式（AgentTavern）回合记录**插件预注入面**——systemPrompt 片段（kernel/preset/facts/guides/script + mod 段，分面展示）、本步注入消息（锚定/开场提醒）与 agent/request 链尾实发调用参数（宿主拼装的历史/工具上下文不可见，面板如实标注）；进程内环形缓冲（每聊天最近 10 条、总量 50，重启即失），记录失败绝不影响生成。详见 [`decisions/2026-10-11-prompt-viewer.md`](decisions/2026-10-11-prompt-viewer.md) 与 [`decisions/2026-10-11-agent-prompt-viewer.md`](decisions/2026-10-11-agent-prompt-viewer.md)。

### 酒馆美化前端

把完整 HTML 文档、`<head>`/`<body>` 片段放进助手消息，或使用 `html` Markdown 代码块。消息保存后，
Tavern transcript 会识别并挂载前端；流式生成和编辑消息时仍显示源码，避免半成品脚本被重复执行。

支持的输入形式：

- 完整文档：`<!doctype html>...` 或同时包含 `<html>` 与 `<head>`/`<body>` 的文档。
- HTML 片段：包含 `<head>` 或 `<body>` 的片段；缺少外层文档时，运行时会自动补齐 `doctype`、viewport 和基础样式。
- Markdown fenced code block：代码块语言可以写成 `html`；普通代码块和不完整 HTML 仍按文本显示。

例如：

````markdown
```html
<!doctype html>
<html>
  <body>
    <button id="counter">0</button>
    <script>
      let count = 0
      document.querySelector('#counter').onclick = () => {
        document.querySelector('#counter').textContent = String(++count)
      }
    </script>
  </body>
</html>
```
````

每个前端使用 `sandbox="allow-scripts"` 的独立 iframe，且不授予 `allow-same-origin`：脚本不能读取或操作宿主页面、
Cookie、`window.parent`、`TavernHelper` 和 DSH API（高度回传仅使用受校验的 `postMessage`）。运行时 CSP 允许内联 CSS/JavaScript，
以及以下静态资源源：`cdn.jsdelivr.net`、`testingcf.jsdelivr.net`、`cdn.tailwindcss.com`、
`cdnjs.cloudflare.com`、`unpkg.com`、`esm.sh`、`fonts.googleapis.com` 和 `fonts.gstatic.com`；图片、字体和媒体
可使用 `https:`、`data:` 或 `blob:` URL。

以下能力明确不在运行时范围内：

- `fetch`、XHR、WebSocket 等业务网络连接（`connect-src 'none'`）。
- 嵌套 iframe、`object`/插件、表单提交和访问宿主 DOM、Cookie、存储或 API。
- 依赖 SillyTavern 宿主注入对象的脚本；需要这些对象时应改为自包含 HTML/JS。

iframe 高度由 `ResizeObserver` 回传，并限制在 80-1200px；超出部分在 iframe 内滚动。TUI/headless
仍显示原始消息文本，不执行前端脚本。

安装插件并重启 DSH 后，可以在 Tavern 聊天中发送上面的示例，或让模型生成一个带按钮的 `html` 代码块，
保存消息后点击按钮即可验证 HTML、CSS 和 JavaScript 是否正常运行。

### Tavern 管理面板

点击 DSH 原生侧栏底部的 Tavern 按钮即可打开管理面板。面板采用与 DSH Settings 接近的两栏布局，左侧切换分区，右侧集中处理资产和行为配置；窄屏会自动将分区导航折叠为横向滚动栏。导航列里「Tavern + 版本号」品牌块**常驻不滚**，只有分区清单自己滚动（分区数会随 Mod 追加而增长，滚动余量不该吃掉面板的身份信息）；右侧分区标题栏同理固定，只有内容区滚动。分区图标按语义取形——「游戏」是手柄图标（与「总览」的 sparkle 区分，「游戏」的四种入口：面板分区、右侧栏 tab、标题栏按钮、空态卡同款）。

面板包含以下分区：

- **总览**：查看当前角色、预设、人设、世界书开关和各类资产数量。
- **角色卡**：导入 PNG、CHARX、JSON；查看卡面；编辑名称、昵称、描述、性格、场景、开场白、示例对话、系统提示词、作者信息和高级 JSON；保存时尽量保留原始 PNG/CHARX 容器及内嵌资源；可导出原格式并删除角色及其聊天。
- **世界书**：导入和导出原生世界书 JSON；编辑世界书名称、条目关键词、次关键词、备注、正文、排序、深度、概率、启用、常驻和选择性匹配；支持新增、删除和搜索条目。
- **预设**：导入和导出原生 preset JSON；聊天补全预设可以编辑提示词堆栈、标识符、角色、内容和 marker；context、instruct、textgen sampler 等预设可以通过高级 JSON 编辑全部字段。
- **聊天、指引、群组、人设、正则、变量**：沿用原有管理能力，并统一放在同一面板中，避免在设置页堆叠长表单；指引分区管理当前角色 + 聊天的持续指引。
- **小说**：AgentNovel 小说库，新建全自动写作的小说工程并查看既有工程。
- **剧本**：导入 TXT/Markdown/EPUB 为剧本资产（自动分块），管理分块、与角色卡的绑定（一卡一剧本）和进度。
- **工作台**：卡片工作台的方案确认入口——展开查看 Agent 提出方案的逐字段改动（当前 / 改为），「批准并应用」写入工作版或「拒绝」；方案带待确认/已批准/已拒绝/已应用状态。工作台分区另有「试写」：选定聊天与一句用户语，按当前激活预设/人设/世界书完整装配后跑一次真实生成，但零副作用——不落楼、不结算、不触发事件（排错与试写专用，见 [`decisions/2026-10-11-preview-generation.md`](decisions/2026-10-11-preview-generation.md)）。聊天排错按聊天粒度组织：侧边栏聊天行的写卡按钮为该聊天拉起/复用专属写卡工作会话（每个聊天一个，落在专用内部工作区，集中显示在侧边栏「写卡工作台」分组），也可拉起不绑定聊天的自由工作台；Agent 用 `chat_log_read` 引用指定聊天与楼层范围。
- **Mods**：Mod 扩展的管理面——已识别 Mod 的清单、能力声明 Pill、错误位（含 engines 版本不满足的原因）与审计计数，全局 / 单 Mod 两层开关、git 安装与重载；首次启用弹确认层（知情同意，含无沙箱告知）。

编辑器会显示未保存状态，取消离开时提示确认，页面关闭时提供浏览器级离开保护。角色卡、世界书和预设的保存都经过服务端格式校验，再写回 `$DSH_HOME/tavern/`。

## 原生集成

插件保留独立的 RP prompt/生成循环，但 UI 进入 DSH 原生表面：

| DSH slot | 用途 |
|---|---|
| `conversation.view` | Tavern JSONL transcript |
| `conversation.composer` | Tavern session 的 RP 输入框、模型选择与 Stop |
| `conversation.session.header.actions` | 当前角色、regenerate 与原生 session stats |
| `settings.section` | Active setup 快速切换与打开 Tavern 面板的入口 |
| `shell.overlay` | Tavern 管理面板 Modal，以及侧栏聊天树 adapter 的生命周期承载 |
| `sidebar.footer.action` | 常驻 Tavern 面板按钮，与原生 Settings 并列 |

DSH `rc.6` 没有可追加到原生 session tree 的正式 list slot。侧边栏因此使用一个集中、版本敏感但失败关闭的 DOM adapter：只匹配可见左侧 `[role="tree"]`，按 workspace 路径/ID 隐藏 `Tavern (internal)` 分组，并按 `state.sessionBindings` 过滤旧版 Tavern 会话行；同时插入具名 `data-dsh-tavern-sidebar-host`。宿主重绘或虚拟列表更新时会重新应用过滤，解绑或卸载时可逆恢复。面板入口本身走官方 `sidebar.footer.action`，不会替换 Settings，也不依赖 adapter 是否成功挂载。侧栏「酒馆」与「写卡工作台」分区标题行可点击整块折叠（chevron + `aria-expanded`，折叠时「新建自由写卡工作台」按钮仍可用）；docked 侧栏门户与管理面板聊天分区两个挂载点共享同一折叠态，页面重载恢复全展开。

每个 Tavern chat 绑定一个正式 DSH session。绑定 API 通过插件内部桥接追加 plugin notice marker，使 session 进入 active 状态而不调用模型；Tavern view、composer 和标题栏 action 仅接管带有效 Tavern marker 的 session，普通 DSH 会话保持原生表面。酒馆标题栏会局部隐藏 DSH 自带的 agent preset 标签，并在切换回普通会话时恢复；Tavern 自建生成循环会把 turn/step、流式 chunk、assistant message 和 provider usage 镜像进同一 session，因此标题栏直接复用 DSH 的 `sessionStats` / `tokenUsage` projection。删除聊天时会追加 close marker 并归档对应 DSH session。

### AgentTavern 当前状态

| 架构 / 模式 | 状态 | 实际行为 |
|---|---|---|
| `agent-tavern` + `dsh-native` | rc.6 可用，单角色新聊天默认启用 | 使用 DSH 原生 AgentLoop 和 composer；模型、工具调用、Stop、错误与统计都由宿主处理，原生 user/final assistant 事件投影到 Tavern JSONL。激活预设以 `dsh-tavern:agent-preset` systemPrompt section 注入（内容提示词 + `temperature`；资产 marker 由工具与可选预载承接）。 |
| `agent-tavern` + `agent-managed` | rc.6 不可用 | 设置页显示宿主缺少 `agent/context` 与 projection-aware compaction 的原因并禁用选项；服务端也会拒绝该模式。 |
| `st` | 保留并兼容 | 使用 Tavern 自有 `/generate`、流式生成、swipe、regenerate 和 STscript 路径。 |
| 群聊 | 固定使用 `st` | 宿主尚未提供可靠的 actor 元数据前，不创建群聊 AgentTavern 会话。 |

AgentTavern 工具的身份来自真实 DSH agent binding，模型不能通过参数伪造 `sessionId`、`scopeId`、角色或聊天身份。当前工具面如下：

| 工具 | 作用 |
|---|---|
| `tavern_character_get` | 读取当前绑定角色的名称、昵称、身份摘要、描述、性格、场景和角色卡版本。 |
| `tavern_lore_search` | 按查询词和预算检索全局启用、角色关联及卡内嵌世界书。 |
| `tavern_history_search` | 在当前绑定聊天（可选回溯 bookmark 父分支）按词法检索历史消息。 |
| `tavern_scene_get` | 读取当前绑定聊天的场景、消息数量和聊天元数据。 |
| `memory_search` | 在当前 chat、character、agent 或 global 作用域做有来源的词法记忆检索；配置 embed 来源后升级为词法 + 语义的混合检索（RRF 融合，可选配置、默认关闭）。来源两种（面板「检索模式」三态下拉切换：关闭/远程/本地）：OpenAI 兼容远程端点（提案 0016），或本地 ONNX 模型目录（提案 0017——管理面板一键安装运行时（profile 根执行 pnpm add，装完即生效免重启），经 onnxruntime-node 进程内推理，离线零网络；池化/维度留空时按模型目录自动推断；量化精度下拉按目录智能识别可选档位、默认自动取 FP16 优先链（2026-10-13 补记），推荐 `Xenova/bge-small-zh-v1.5`，ModelScope 有镜像）。 |
| `memory_read` | 按稳定 id 读取一条记忆及其来源。 |
| `memory_write` | 在选定作用域写入带来源、标签、置信度的记忆；global 写入需在设置中显式开启。 |
| `memory_update` | 按 id + expected revision 条件更新记忆，未提供的字段保持原值。 |
| `memory_forget` | 按 id + expected revision 软删除记忆，保留审计记录。 |
| 记忆维护 | 记忆工具之外，管理面板「记忆检索」分区可对单个聊天手动发起记忆维护 run（服务端维护 LLM，非模型工具面）：按原文依据合并跨写入批次的重复事件、纠正冲突陈述、删除被证伪记录；完成收据记录楼面指纹与记录版本快照，原文或记忆再被改动即退役、对应范围下轮重扫（决策 2026-10-11-memory-maintenance）。 |
| `variable_get` | 读取当前作用域中的 typed JSON 变量。 |
| `variable_set` | 写入变量并支持 expected revision 的 CAS 冲突保护。 |
| `variable_patch` | 在同一作用域原子写入多个变量，任一 revision 冲突则整批失败。 |
| `variable_delete` | 删除当前作用域变量，需 revision 匹配。 |
| `variable_list` | 按前缀列出作用域内变量名和值摘要。 |
| `tavern_variable_settle` | 单轮批量结算受追踪变量：写 chat 作用域变量并记录 MVU 回执（每项变更前后值、失败项）与审计行；失败项重试是新的一次结算，正文不受影响。 |
| `tavern_script_read` | 读取当前绑定剧本在进度位置（或指定 `chunkIndex`）的片段；未绑定剧本时返回 `found:false` 可优雅跳过。 |
| `tavern_script_advance` | 最新正文实际覆盖当前片段后推进一格进度（玩家偏离不推进），记录 `alignedAt` 与可选备注；最后一段返回 `done:true`。 |
| `game_list` | 列出内置/导入/Mod 三源游戏（id、名称、人数、动作词汇表——用 id 调 `game_start`）与本聊天会话（sessionId、游戏名、轮到谁、终局态、手数）。 |
| `game_start` | 用 `gameId` 在当前绑定聊天开一局（可选 `role` 选 Agent 执方，缺省后手）；返回会话身份（sessionId、游戏名、players 角色归属、先手方）——**不含棋盘**（token 经济：局面经 `game_state` 按需读取）。人类执先时开局后立即 `game_wait`。 |
| `game_state` | 读取当前局面（扁平最小载荷）：`state` 棋盘、`legal` 建议集、轮到谁（`turn`/`turnOwner`）、`moveCount`、终局态（`finished`/`winner`/`summary`）；**不含动作日志**——往手经 `game_history` 读取。 |
| `game_history` | 读取动作日志（交互历史）：每条 `{actor, action, describe}`（describe 即该手叙述文案）；缺省返回最近 20 手，`from`（0 基下标）+ `limit`（上限 200）分页，`moveCount` 是日志总量。 |
| `game_move` | Agent 落子（与人类玩家共用同一动作语言与引擎合法性终审）；返回 `describe` 叙述文案与轮次/终局态（`finished`/`winner`/`summary`）——不回吐棋盘与日志（读归读、写归写），可直接用于对话。落到人类回合后接 `game_wait`。`{type:"resign"}` 认输——面板开启「禁用投降」后两个动作入口（人类棋盘/本工具）一致拒绝。 |
| `game_wait` | 阻塞等待人类在棋盘上落子（2026-10-14 修订；同日 token 经济修订）：Agent 在自己回合内挂起，人类落子经跨 bundle 写穿唤醒，工具只返回**等待期增量**——`newMoves`（等待期到达的手，通常即人类刚落的那手，`{actor, action, describe}` 供叙述；已在 Agent 回合时恒空——落子前的局面经 `game_state` 读取）与轮次/终局态，Agent 同回合自动续弈——**用户无需发送聊天消息触发下一步**。`timeoutMs` 限 1000..900000（缺省 300000）；超时返回 `status:"timeout"` 不报错（模型可再等）；用户停止生成时随 `exec.signal` 中止。**Agent 没 wait 就结束回合时同样不丢手**：人类落子由插件侧自动唤起（经宿主 `followup` 投递一条插件来源的「自动游戏通知」消息，`game_wait` 挂起中不重复投递）——两个方向都不需要用户发聊天消息。对局棋盘自动显示在与 MVU 状态同位的地方：ST 架构内联在聊天视图 MVU 状态卡下方，AgentTavern 架构为 DSH 原生右侧栏「游戏对局」tab（开局自动展开；标题栏另有与 MVU 同位同款的入口按钮）——棋盘经「先读水位基线再拉数据」的两档轮询（对局中 1s/守望 5s）自动刷新。 |

变量工具支持 `chat`、`character`、`agent`、`global` 与 `turn` 作用域；`turn` 作用域是单轮 scratch 状态，turn 结束时自动清空，`global` 写入默认关闭、需在设置中开启。角色卡支持可编辑的 `agentTavern.identitySummary` 身份摘要（管理面板角色编辑器内），AgentTavern 内核每轮注入该摘要；缺失时回退为名称和极短描述。投影失败时管理面板"变量"分区提供状态查询和一键重放入口。

ST 与 AgentTavern 新聊天共用 `$DSH_HOME/tavern/workspace/` 下的 `Tavern (internal)` 工作区；插件按 workspace 路径/ID 从原生侧边栏隐藏整个分组，旧宿主没有身份属性时仅在标题唯一时回退。升级前已经存在的宿主会话不会跨工作区迁移，但绑定的 Tavern 会话行仍会按插件过滤。

### AgentNovel 当前状态

`agent-novel` 是与 AgentTavern、ST 并列的第三种会话架构：全自动小说推演（[提案 0005](docs/proposals/0005-agent-novel-architecture.md)、写手子代理补充见 [提案 0007](docs/proposals/0007-agent-novel-writer-subagent.md)）。先落盘大纲再分单元写作，正文只经 `novel_body_commit` 原子提交，作者指令走台账 + 修订协议，冲突指令必须引用用户澄清/撤回消息才能解除。

| 能力面 | 状态 |
|---|---|
| 存储 / 调度 / 提交协议 | 可用：HEAD 单一提交点、不可变修订快照、单写者所有权、认领令牌与幂等重试 |
| 作者干预 | 可用：指令接收屏障、修订覆盖层（chapters overlay + droppedChapterIds）、blocked 冲突暂停与澄清引用解除 |
| 写手子代理 | 可用（`writerMode: inline | subagent`，默认 inline）：W1 产稿 + W2 单单元委托自提交，真机 A/B 后再切默认 |
| 阅读 / 导出 | 可用：章节 Markdown 投影、ZIP 导出、记忆检索索引 |

模型侧工具面（`novel_*`，身份一律来自会话绑定，不接受参数传入 novelId）：`novel_status_read`、`novel_requirements_read`、`novel_outline_read/create/revise`、`novel_requirement_block`、`novel_unit_claim/supersede`、`novel_body_commit/read/search`、`novel_chapter_complete`、`novel_finish`、`novel_character_read`、`novel_lore_search`、`novel_facts_read`、`novel_writer_draft/delegate`，以及绑定小说作用域的 `memory_search` / `memory_read` 和 `tavern_deduce` 适配器。设计契约以提案 0005 §11 工具表为准。

## Packages

| Package | 说明 |
|---|---|
| `@dsh-tavern/format` | 卡、PNG/CHARX、世界书、preset（chat completion / context / instruct / textgen）、群组文件、regex 脚本和 chat JSONL 的解析与无损往返 |
| `@dsh-tavern/lore` | World Info 激活和 timed effects 引擎 |
| `@dsh-tavern/macros` | 角色、时间、随机、变量等宏引擎 |
| `@dsh-tavern/pipeline` | preset 顺序、lore、persona、历史和 token budget 的 prompt 装配（chat completion + 群聊回合） |
| `@dsh-tavern/script` | ST regex 脚本执行器与 STscript 解释器 |
| `@dsh-tavern/store` | `$DSH_HOME/tavern/` 原子文件存储、revision 和 session binding |
| `@dsh-tavern/template` | EJS Prompt Template 引擎：`node:vm` 沙箱执行、作用域变量与内容注入（提案 0008） |
| `@dsh-tavern/bind` | 跨 DSH 版本的宿主形状兼容层：会话事件探测、宿主包锚解析、client 连接双面回退与宿主形状诊断 |
| `dsh-tavern` | 自包含 Node half（含 agent / compaction / novel / card-workbench 入口，以及 Mod 加载器与能力面宿主 `src/mods/`，提案 0015）、Web client half（含 Mods 面板分区与 Mod iframe 桥）、随附示例 Mod（`examples/mods/`，三个示例覆盖 v1 全部能力面：asset-stats 资产只读统计、mood-tracker post-output hook + 情绪工具对 + iframe 面板、story-clock 剧情时钟——聊天变量 `clock` + `{{clock}}` 宏 + `/clock` 命令族 + `llm` 门控摘要）、安装元数据和 gates |

## 安装

要求 Node.js 22+，并已安装 DSH。

### 首次安装

```sh
git clone https://github.com/LingyeSoul/dsh-tavern.git
cd dsh-tavern
pnpm install
pnpm run build:plugin
dsh plugin --profile web add ./packages/plugin
dsh --profile web
```

### 桌面版（desktop profile）

DSH 桌面版的插件安装框等价于在 profile 目录执行 `pnpm add <spec>`，安装目标是 `desktop` profile。spec 必须落到 `packages/plugin`：仓库根是 monorepo 容器，不声明 `dsh.bundle.patch`，插件管理器会以「这个包没有声明组合包，不能作为插件管理」拒绝，并回滚 `package.json` 与 `pnpm-lock.yaml`。

桌面版「设置 → 插件 → Git 仓库」填子目录 spec：

```sh
github:LingyeSoul/dsh-tavern#path:/packages/plugin
```

等价的 HTTPS 写法（`#path:` 参数相同）：

```sh
https://github.com/LingyeSoul/dsh-tavern#path:/packages/plugin
```

命令行安装到 desktop profile（`dsh plugin` 把参数原样转发给 pnpm）：

```sh
dsh plugin --profile desktop add github:LingyeSoul/dsh-tavern#path:/packages/plugin
dsh --profile desktop
```

已有源码检出时可直接挂本地目录；桌面版安装框只接受绝对路径，相对路径会被 install-spec 拒绝：

```sh
dsh plugin --profile desktop add <仓库绝对路径>/packages/plugin
```

git spec 固定到安装时的提交，不跟随源码更新；`version.json` 不纳入 Git，设置页显示的是构建期注入的版本与 commit（`scripts/build-plugin.mjs` 经 esbuild `define` 写入 `__TAVERN_VERSION__`/`__TAVERN_COMMIT__`）。

### 内置自更新（发现新版本 + 一键更新）

插件自带从 GitHub 发现新版本与一键更新，桌面版不需要再手敲 `dsh plugin`。

- **发现**：「设置 → dsh-tavern」标题下与管理面板「总览」分区显示当前构建（`已安装 v0.4.5 (7a29db6)`）、GitHub 上的最新构建、待合入的 commit 列表与上次检查时间。启动后延迟 12s 首查、每 6h 复查，结果缓存在 `$DSH_HOME/tavern/update-state.json`；「检查更新」按钮穿透缓存立即查。
- **判定**：仓库不发 release/tag，因此以 main 分支最新 commit + `packages/plugin/package.json` 的 version 为准（规则见 [`decisions/2026-10-05-desktop-plugin-self-update.md`](decisions/2026-10-05-desktop-plugin-self-update.md)）。
- **更新**：「立即更新」按 `dsh plugin`（桌面版自带 CLI，直接改 profile 的 `package.json` + `pnpm-lock.yaml`）→ `plugin-manager` 服务 → GitHub checkout 覆写的顺序落地，进度日志实时显示在卡片里。三条路径都需要**重启 DeepSeek Harness**：包替换要新的 JS module generation，宿主 HMR 不监听 `node_modules`。安装成功后安装器会把目标 commit 统一落进已安装目录的 `version.json` 旁车——运行中构建的身份以「模块加载时磁盘上的旁车」为准（烤进 bundle 的构建期字面量对随源入库的 dist 恒为父提交，只做旁车缺席时的兜底），重启加载新安装后「需要重启」即解除；过渡态缓存按安装目录隔离（`update-state.json` 在多 profile 间共享，别处装出的 pendingRestart 不会压到本目录），`force` 可穿透卡住的过渡态重装（收敛机制见 [`decisions/2026-10-12-update-restart-required-stuck.md`](decisions/2026-10-12-update-restart-required-stuck.md)）。
- **来源降级**：`api.github.com` → `raw.githubusercontent.com` + `git ls-remote` → commits atom feed。企业 TLS 中间人会让 node 的 `fetch` 证书校验失败（`unable to verify the first certificate`），因此每个 HTTP 请求在 fetch 失败后自动用系统 `curl` 重试。
- **开关**：profile 的 `dsh-tavern` 行写 `checkForUpdates: false`，或设 `DSH_TAVERN_DISABLE_UPDATE_CHECK=1` 关闭自动发现；`DSH_TAVERN_DISABLE_CURL=1` 关闭 curl 兜底；`GITHUB_TOKEN`/`GH_TOKEN` 可提高 GitHub 限流配额。
- **HTTP 端点**：`GET /api/dsh-tavern/update`（缓存快照，`?refresh=1` 穿透 TTL）、`POST /api/dsh-tavern/update/check`、`POST /api/dsh-tavern/update/install`（`{ "wait": false }` 立刻返回，进度轮询 `GET update`）。

### 更新

装了插件之后优先用面板里的内置自更新（见「内置自更新」一节）：发现新版本 → 一键更新 → 重启 DSH。手改源码的开发流程仍是：

`dsh plugin add` 以本地 link 方式挂载插件，因此代码更新后只需重新构建并重启 DSH：

```sh
cd dsh-tavern
git pull
pnpm install
pnpm run build:plugin
dsh --profile web
```

若遇到依赖残留或版本不一致，可先移除再重新添加：

```sh
dsh plugin --profile web remove dsh-tavern
dsh plugin --profile web add ./packages/plugin
```

### 插件结构备注

跨 DSH 版本的宿主形状兼容层（会话事件日志探测、宿主包锚解析、client 工作区
连接双面回退、client UI 原子解析、宿主形状诊断）集中在 `packages/bind`
（`@dsh-tavern/bind`），更新版本适配时先改这里。client half 的源文件是
`packages/plugin/client/main.js`；
`client/index.js` 是 `pnpm run build:plugin` 的拼接产物（把 bind 的 client
探测模块注入 `__DSH_BIND_CLIENT_SLOT__` 标记处），不要直接手改，改了会被下次
构建覆盖。插件激活时会输出一行 `dsh-tavern host shape: {...}` 日志，报告命中的
宿主形状绑定路径，排查宿主版本差异从它读起。

### 验证

```sh
pnpm run check
```

打开 DSH 后：

1. 点击侧栏底部的 Tavern 按钮，或从“设置 -> dsh-tavern”打开 Tavern 面板。
2. 在“角色卡 / 世界书 / 预设”分区导入资产；导入后可以直接编辑、保存、搜索、设为当前或导出。
3. 在设置中选择新聊天架构（单角色新聊天默认 AgentTavern/native，群聊始终使用 ST）。
4. 在原生左侧 Tavern 分支展开角色并创建或打开单角色聊天：AgentTavern 使用 DSH 原生 conversation，ST 使用原生 `Tavern` tab。
5. 在 ST 聊天中验证编辑、swipe、regenerate 和 STscript；在 AgentTavern 聊天中验证原生 composer、工具调用、Stop 和会话统计。

插件 Node half 是五个自包含 bundle：`index.mjs` 主入口，加 `agent` / `compaction` / `novel` / `card-workbench` 四个子代理入口（见 `package.json` 的 `exports`）；`@dsh-tavern/*` 工作区库（format / lore / macros / pipeline / script / store / template / bind）全部内联，无运行时依赖。无需用户额外安装公共 `@deepseek-ai/*` 运行时依赖；client closure 由 DSH profile 注入。

## 测试基线

```sh
pnpm run check
```

当前基线：101 个测试文件、1578 项测试通过（`skipIf` 环境条件项按本机实际状态计，全量实测 0 跳过）；15 个插件 gates（含 update-routes、package-contract、AgentTavern 隔离、native header adapter、MVU 挂载面、内部工作区、client VM mount、V4 session admission 和 mod-loader）全部通过。完整 `pnpm run check` 需要可解析 DSH 官方运行时；本仓库验证使用 DSH `0.2.0-rc.2` 的隔离 runtime（`.npm-cache/dsh-runtime`，受限环境依次回落 `NODE_PATH` 与全局安装）。会话事件写入的宿主契约（V4 关系准入、assistant 结算 `usage`/`stream`）由 `packages/plugin/tests/agent-tavern-session-admission.spec.ts` 直接对真实宿主代码回归。示例 Mod 的 engines 与随仓库发布的宿主版本由 `packages/plugin/tests/tavern-mods-examples.spec.ts` 防漂移守卫锁定（2026-10-12 story-clock `^0.4.1` 卡死 0.5.0 宿主的事后修复，见 [decisions/2026-10-12-story-clock-engines-drift.md](decisions/2026-10-12-story-clock-engines-drift.md)）。管理面板导航列「品牌块常驻 + 清单独占滚动」与游戏手柄图标由 `packages/plugin/tests/tavern-panel-layout.spec.ts` 和 `games-client.spec.ts` 锁定（2026-10-14 用户反馈，见 [decisions/2026-10-14-panel-nav-fixed-brand-and-gamepad-icon.md](decisions/2026-10-14-panel-nav-fixed-brand-and-gamepad-icon.md)）。移动端 700px 断点里清单容器退场（`.dt-panel-navlist{display:contents}`——修复「品牌块常驻」的包装器在横向按钮条里竖排堆叠分区按钮、主区被挤没的回归）由 `tavern-panel-layout.spec.ts` 新增用例与 gates `frontend-runtime` 的 marker（含负样本）锁定（2026-10-14 移动端实况，见 [decisions/2026-10-14-panel-mobile-navlist-strip-regression.md](decisions/2026-10-14-panel-mobile-navlist-strip-regression.md)）。五款内置游戏（井字棋/五子棋/中国象棋/军棋/21 点）的引擎契约与规则面由 `packages/plugin/tests/games-builtin.spec.ts` 与 `games-xiangqi.spec.ts`/`games-junqi.spec.ts`/`games-blackjack.spec.ts` 锁定（中国象棋与军棋均含视图内联预览局面与引擎真实开局的一致性防漂移，见 [decisions/2026-10-14-xiangqi-builtin.md](decisions/2026-10-14-xiangqi-builtin.md)、[decisions/2026-10-14-junqi-builtin.md](decisions/2026-10-14-junqi-builtin.md) 与 [decisions/2026-10-14-blackjack-builtin.md](decisions/2026-10-14-blackjack-builtin.md)）。21 点视图的坐席归属（人类可坐庄——提示/按钮/终局结果条一律按 owner 反查落笔，杜绝「庄家（AI）」式默认坐席文案；按钮随 `view.legal` 收缩）由 `games-blackjack.spec.ts` 的 DOM 垫片行为用例（真跑内联脚本 + 真实下行载荷）锁定（2026-10-14 用户实况「庄家和玩家的显示反了」，见 [decisions/2026-10-14-blackjack-seat-ownership-view.md](decisions/2026-10-14-blackjack-seat-ownership-view.md)）。中国象棋的对局提示层（将军警报横幅三语境、被将帅脉冲圈 + 光晕、解将行动指引）由 `games-xiangqi.spec.ts` 锁定（2026-10-14 用户反馈，见 [decisions/2026-10-14-xiangqi-check-prompts.md](decisions/2026-10-14-xiangqi-check-prompts.md)）。游戏工具面的 token 经济契约（扁平最小载荷：`game_wait` 只回等待期增量 `newMoves`、`game_move` 只回 `describe`+轮次、`game_history` 窗口缺省 20 手/上限 200/`from` 分页、会话快照去 `moves` 换 `moveCount`、身份面只在 `game_list`/`game_start` 出现一次）由 `games-tools.spec.ts` 与 `games-service.spec.ts` 锁定（2026-10-14 用户反馈，见 [decisions/2026-10-14-games-delta-tools.md](decisions/2026-10-14-games-delta-tools.md)）。人类落子自动续弈（等待登记防重、插件来源通知形状、逐级降级）由 `games-autowake.spec.ts` 锁定（见 [decisions/2026-10-14-games-autowake.md](decisions/2026-10-14-games-autowake.md)）；投降策略（出回合投降语义、两入口拒绝闸、按钮与终局盘面）由 `games-service.spec.ts` 与 `games-client.spec.ts` 锁定（见 [decisions/2026-10-14-games-resign-policy.md](decisions/2026-10-14-games-resign-policy.md)）。自更新 checkout 兜底的发布清单单一事实来源（`copyShippedFiles` 从 package.json `files` 运行时派生，杜绝 SHIPPED 硬编码漂移；含 card-workbench 混装回归与上抛负样本，package-contract gate 同步补齐五 bundle 的 files/exports 契约面）由 `tavern-update.spec.ts` 锁定（见 [decisions/2026-10-14-update-checkout-shipped-files-drift.md](decisions/2026-10-14-update-checkout-shipped-files-drift.md)）。游戏工具面坐标容错（整数的字符串形态归一为数字——模型桥把工具参数数字写成引号串的实弹停摆修复）由 `parseBoardCoord` 单元（games-builtin.spec.ts）+ 四内置/参照包容错用例 + `games-xiangqi.spec.ts` 实弹形状端到端锁定（2026-10-14 实弹对局 g-54e612c8，见 [decisions/2026-10-14-quoted-coordinate-tolerance.md](decisions/2026-10-14-quoted-coordinate-tolerance.md)）。

GUI 已在桌面和 390x844 移动视口验证，包括原生 sidebar、Tavern 管理面板、角色卡/世界书/预设编辑器、conversation view/composer、流式生成、Stop、edit、swipe、regenerate、rename/delete 和 revision 冲突。

## 文档

- [`docs/proposals/0001-tavern-architecture.md`](docs/proposals/0001-tavern-architecture.md)：当前架构、边界与后备路线。
- [`docs/proposals/0002-branch-persona-groups-script-textcompletion.md`](docs/proposals/0002-branch-persona-groups-script-textcompletion.md)：branch/bookmark、persona 管理、群聊、STscript/regex 与 Text Completion/Kobold 的范围与格式。
- [`docs/exploration/2026-08-14-fabric-architecture.md`](docs/exploration/2026-08-14-fabric-architecture.md)：Fabric 调研与后备定位。
- [`docs/exploration/2026-08-14-st-formats.md`](docs/exploration/2026-08-14-st-formats.md)：SillyTavern 互操作格式与行为参考。
- [`decisions/2026-08-14-card-raw-passthrough.md`](decisions/2026-08-14-card-raw-passthrough.md)：角色卡未知字段透传决策。
- [`decisions/2026-08-15-v2-feature-scope.md`](decisions/2026-08-15-v2-feature-scope.md)：v2 功能面的范围与形态选择。
- [`docs/proposals/0003-tavern-management-panel.md`](docs/proposals/0003-tavern-management-panel.md)：Tavern 管理面板的信息架构、slot 选择和交互范围。
- [`docs/proposals/0004-agent-tavern-architecture.md`](docs/proposals/0004-agent-tavern-architecture.md)：AgentTavern 原生 AgentLoop 架构、记忆/变量工具、遗忘策略和 ST 兼容模式。
- [`docs/proposals/0005-agent-novel-architecture.md`](docs/proposals/0005-agent-novel-architecture.md)：AgentNovel 全自动小说推演架构（存储、调度、提交协议与作者干预）。
- [`docs/proposals/0006-usage-anchored-compaction-pressure.md`](docs/proposals/0006-usage-anchored-compaction-pressure.md)：以用量为锚的压缩压力设计。
- [`docs/proposals/0007-agent-novel-writer-subagent.md`](docs/proposals/0007-agent-novel-writer-subagent.md)：AgentNovel 写手子代理（inline / subagent 两种模式）。
- [`docs/proposals/0008-prompt-template.md`](docs/proposals/0008-prompt-template.md)：EJS Prompt Template 沙箱、作用域变量与内容注入。
- [`docs/proposals/0009-conversation-guides.md`](docs/proposals/0009-conversation-guides.md)：持续指引（Guide）。
- [`docs/proposals/0010-turn-candidates.md`](docs/proposals/0010-turn-candidates.md)：行动候选生成。
- [`docs/proposals/0011-rewrite-with-feedback.md`](docs/proposals/0011-rewrite-with-feedback.md)：带意见重写。
- [`docs/proposals/0012-mvu-settlement.md`](docs/proposals/0012-mvu-settlement.md)：MVU 后台变量结算、回执与固定状态栏。
- [`docs/proposals/0013-card-workbench.md`](docs/proposals/0013-card-workbench.md)：卡片工作台（对话改卡 + 确认协议 + 制卡/排错）。
- [`docs/proposals/0014-script-play.md`](docs/proposals/0014-script-play.md)：剧本游玩（剧本库、绑定、对齐推进）。
- [`docs/proposals/0015-mod-extensions.md`](docs/proposals/0015-mod-extensions.md)：Mod 扩展接口与加载机制（清单校验、三层开关、五相位 hook 总线、能力面与信任边界；配套决策 2026-10-10-mod-p0/p1/p2 三篇）。
- [`docs/proposals/0016-hybrid-memory-retrieval.md`](docs/proposals/0016-hybrid-memory-retrieval.md)：混合记忆检索（OpenAI 兼容 embed 配置、向量 sidecar 与输入摘要、双通道 RRF 融合、熔断/回填/降级矩阵；配套决策 2026-10-11-retrieval-eval-matrix 检索评测矩阵与质量门槛）。
- [`docs/proposals/0017-local-onnx-embed.md`](docs/proposals/0017-local-onnx-embed.md)：本地 ONNX embed（provider 判别联合配置、transformers.js 运行时多锚解析、目录指纹向量身份、dtype FP16 优先链、onnxruntime-web 评估否决留档；真模型冒烟含生产拓扑端到端；2026-10-13 补记：量化精度可选——目录智能识别 + 面板下拉、身份进精度段、validate 收紧 onnx/ 布局）。
- [`docs/proposals/0018-agent-game-bridge.md`](docs/proposals/0018-agent-game-bridge.md)：Agent 游戏桥（标准游戏引擎契约 + 侧边栏对局面 + Mod/导入扩展；权威状态在 Node 的第一性论证、WS 否决留档、五子棋参照实现补记与标准修订；2026-10-14 补记：game_wait 阻塞等待 + 内置五子棋回归；同日二次补记：wait/move 增量返回 + game_history 读取面——会话快照去 moves 换 moveCount）。实施决策见 [decisions/2026-10-13-agent-game-bridge.md](decisions/2026-10-13-agent-game-bridge.md)、[decisions/2026-10-14-gomoku-builtin.md](decisions/2026-10-14-gomoku-builtin.md) 与 [decisions/2026-10-14-games-delta-tools.md](decisions/2026-10-14-games-delta-tools.md)。
- [`docs/plans/2026-08-16-agent-tavern-implementation.md`](docs/plans/2026-08-16-agent-tavern-implementation.md)：AgentTavern 的分阶段施工计划、宿主门禁、迁移规则与验证矩阵。
- [`docs/exploration/2026-08-16-dsh-agentloop-native-audit.md`](docs/exploration/2026-08-16-dsh-agentloop-native-audit.md)：DSH `0.1.0-rc.6` 原生注入、compaction 与 Fabric fallback 审计。
- [`docs/exploration/2026-10-11-jsr-lwb-reference.md`](docs/exploration/2026-10-11-jsr-lwb-reference.md)：JS-Slash-Runner（酒馆助手）与 LittleWhiteBox（小白盒）竞品参考——Mod 生命周期基础设施、$schema 变量写入守卫、多阶段记忆召回、评测基建与不复刻清单；P0 施工项：中文分词修复、MVU 守卫、Mod 桥下行事件与按钮、Mod 日志查看器。
- [`decisions/2026-08-15-tavern-management-panel.md`](decisions/2026-08-15-tavern-management-panel.md)：面板入口、角色删除级联、变量与侧栏共存的落地决策。
- [`decisions/2026-10-05-desktop-plugin-self-update.md`](decisions/2026-10-05-desktop-plugin-self-update.md)：桌面版内置自更新（GitHub 版本发现、落地路径顺序、curl 兜底、构建期 stamp）。
- [`decisions/2026-10-12-update-restart-required-stuck.md`](decisions/2026-10-12-update-restart-required-stuck.md)：自更新「需要重启」永不解除的修复——运行身份改以安装器落戳的 version.json 旁车为准（烤入字面量对随源入库 dist 恒为父提交）、过渡态缓存按安装目录隔离 + force 逃生门、persist 原子写重试。
- [`decisions/2026-10-14-gomoku-builtin.md`](decisions/2026-10-14-gomoku-builtin.md)：内置五子棋回归（提案 0018 §4.1 双内置裁定重审）——开箱可玩面 vs 参照包分工、同 id 遮蔽语义（导入副本为准 + warning）、版本 0.6.1 与示例 engines 连带、视图四态真机验收与边界。
- [`decisions/2026-10-14-xiangqi-builtin.md`](decisions/2026-10-14-xiangqi-builtin.md)：内置中国象棋（提案 0018 §4.1 内置序列第三款）——规则面 v1 裁剪（全着法+将军/照面/将死/困毙实现，长将长捉与限着不实现）、中文象棋记谱设计（前后消歧）、legalActions 完整性优先语义、视图四态真机验收（截图驱动修两处图像缺陷）、版本 0.6.2 连带与边界。
- [`decisions/2026-10-14-panel-nav-fixed-brand-and-gamepad-icon.md`](decisions/2026-10-14-panel-nav-fixed-brand-and-gamepad-icon.md)：管理面板外壳两处修订（2026-10-14 用户反馈）——导航列品牌块常驻 + 清单独占滚动（headless Chrome 量测证据）、游戏图标自绘手柄（宿主图标集无手柄类，四处游戏面同款）。
- [`decisions/2026-10-14-panel-mobile-navlist-strip-regression.md`](decisions/2026-10-14-panel-mobile-navlist-strip-regression.md)：管理面板移动端横向按钮条回归修复（2026-10-14 移动端实况「各个页的按钮占据了整个面板」，因果点名上一次「固定标题栏」改动并经 RCA 证实）——700px 断点里清单容器 `display:contents` 退场、分区按钮回到横条 flex 流（与 6613a75 之前逐像素一致），桌面「品牌块常驻 + 清单独占滚动」契约原样保留；五档真机几何量测 + spec/gates（含负样本）锁定。
- [`decisions/2026-10-14-games-autowake.md`](decisions/2026-10-14-games-autowake.md)：人类落子自动续弈（2026-10-14 用户需求「Agent 没调 wait 就停止运行后，用户操作完游戏由插件自动触发 agent 继续」）——`ctx.agents.get` + `Agent.followup` 插件来源通知（form 'notice'，绝不伪装用户消息）、跨 bundle 等待登记（game_wait 挂起中不重复投递）、冷会话/群聊/无绑定逐级降级、事件语义不重试。
- [`decisions/2026-10-14-games-resign-policy.md`](decisions/2026-10-14-games-resign-policy.md)：投降策略与终局盘面（2026-10-14 用户需求「禁用投降（面板）+ 用户投降按钮（游戏显示区）」「游戏结束应显示盘面」）——`gamesDisableResign` 策略键 + 服务层两入口一致拒绝闸、人类出回合投降例外（actor 重锚）、GameSurface 两步确认投降按钮、终局保留最终盘面（见证集补拉判据）。
- [`decisions/2026-10-14-games-delta-tools.md`](decisions/2026-10-14-games-delta-tools.md)：游戏工具面 token 经济修订（2026-10-14 用户反馈「game_wait/game_move 不再返回全部信息，单独提供工具读交互历史与当前状态」+「游戏系统尽可能考虑 token 经济性」）——会话快照去 `moves` 换 `moveCount`、工具载荷全部扁平最小化（身份面只在 list/start 出现一次；move 实测 526→99 字符，≈164→≈31 token）、`game_wait` 只回等待期增量（`newMoves`）、新增 `game_history` 窗口面（缺省 20 手/上限 200/`from` 分页）、wait 循环改经 `history()` 读快照（不再每拍计算建议集）、版本 0.6.3 连带。
- [`decisions/2026-10-14-xiangqi-check-prompts.md`](decisions/2026-10-14-xiangqi-check-prompts.md)：象棋将军提示层（2026-10-14 用户需求「象棋应该提供提示：如将军提示」）——警报横幅三语境文案（人类被将「必须解将」/ AI 被将「正在解将」/ 未知归属回落）、被将帅光晕、底部解将行动指引；纯视图层单文件（引擎/桥协议/工具面/client 零改动），headless Chrome 三态真机验收（人类被将 / AI 被将 / 对照隔离）。
- [`docs/mods/mod-api.md`](docs/mods/mod-api.md)：Mod 扩展接口的开发者文档（清单、生命周期、全部能力面、面板 UI 表面协议、管理端点与审计），配套官方示例在 [`packages/plugin/examples/mods/`](packages/plugin/examples/mods/)（asset-stats / mood-tracker / story-clock / rps，覆盖 v1 全部能力面）。
- [`packages/plugin/examples/games/dsh-tavern.gomoku/`](packages/plugin/examples/games/dsh-tavern.gomoku/)：[提案 0018](docs/proposals/0018-agent-game-bridge.md) 游戏桥标准（dsh-tavern Game Bridge）的第一个参照实现——五子棋标准游戏包（`game.json` 清单 + `engine.mjs` 零依赖纯函数引擎 + `view.html` 自包含视图），可直接放入 `$DSH_HOME/tavern/games/installed/` 或经 `POST games/install {path}` 导入对弈（清单 engines `^0.6.0` 对宿主版本的门控——0.6.x 全系含当前宿主 0.6.3 均满足）。规则按自由五子棋裁剪（任意方向 ≥5 连即胜、长连也算胜，连珠禁手不实现），保留动作 `resign` 由运行时统一处理。2026-10-14 起五子棋另有**内置实现**（开箱可玩，见 [decisions/2026-10-14-gomoku-builtin.md](decisions/2026-10-14-gomoku-builtin.md)）——本包保留为导入路径参照与可分发标准样本，与内置同 id，导入时以磁盘副本接管槽位（装载期 warning）。游戏桥运行时（`src/games/`：三源注册表 / 会话落盘 / HTTP 面 / `game_*` 六工具——`game_wait` 阻塞等待 + `game_history` 日志窗口，wait/move 只回增量 / MVU 同位对局面 + 面板「游戏」分区）已随 [decisions/2026-10-13-agent-game-bridge.md](decisions/2026-10-13-agent-game-bridge.md) 落地并经 2026-10-14 修订（wait 循环 + 自动展示 + 增量工具面 + 人类落子自动续弈 + 投降门/投降按钮/终局保留盘面）。对局面（棋盘 iframe）之下有**投降按钮**（两步确认防误触），面板「游戏」分区有「禁用投降」开关（开启后按钮隐藏、人类与 Agent 的认输都被服务端拒绝）；终局不再只剩一行结果文案——最终盘面与结果并列展示。

## 插件管理

已安装插件建议使用 plugin-registry 的薄控制台管理 profile 中的 bundle 层栈、insert 行和启停状态，避免手改配置。将 `<plugin-registry>` 替换为该工具仓库的本地路径：

```sh
dsh plugin --profile web add <plugin-registry>/packages/plugin/console
```

## 许可

GPL-3.0。项目只实现公开规范和可观察行为语义，不复制 SillyTavern 的 AGPL 源码。Fabric 与 dsh-ads 仅用于架构调研；第一版运行时不依赖它们。
