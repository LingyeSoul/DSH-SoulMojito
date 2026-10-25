<p align="center"><img src="assets/logo.svg" alt="DSH-SoulMojito logo" width="112"></p>

<h1 align="center">DSH-SoulMojito</h1>

<p align="center">把 DSH（deepseek-harness）扩展成兼容 SillyTavern 生态的原生角色扮演工作区。</p>

<p align="center">
  <strong>v0.7.0</strong> · 面向 DSH <code>0.2.1-rc.2</code>（兼容 <code>0.2.0-rc.2</code>） · GPL-3.0
</p>

## 这是什么

DSH-SoulMojito 是一个 DSH 官方 bundle 形态的插件包（`dsh-soulmojito`）。它做四件事：

1. **接住 SillyTavern 生态** —— 角色卡、世界书、预设、正则脚本、STscript、EJS Prompt Template、群聊、persona 与 JSONL 聊天记录都可导入、编辑、导出，尽量无损往返。
2. **把角色扮演交给 DSH 原生 AgentLoop** —— 单角色新聊天默认跑在宿主原生 conversation 上；插件只提供角色资产、工具面与投影，不拥有第二个主循环。
3. **补齐 DSH 没有的内容生产面** —— 全自动小说推演、对话改卡的卡片工作台、剧本游玩、MVU 变量结算、提示词查看器。
4. **留出扩展位** —— Mod 扩展接口（五相位 hook + 能力面）与 Agent 游戏桥（标准引擎契约 + 九款内置）。

插件复用 DSH 的 LLM 路由、默认模型、密钥管理、Web 容器与插件安装机制，不引入第二套模型配置。Fabric 不在运行路径中，仅作架构调研。

## 三种会话架构

| 架构 | 一句话 | 生成循环 | 适合什么 |
|---|---|---|---|
| `agent-tavern` | 原生 Agent 模式，**单角色新聊天默认** | DSH AgentLoop | 模型自己决定何时查角色、查世界书、写记忆、掷骰 |
| `st` | SillyTavern 兼容模式 | 插件自建 `/generate` | 需要 swipe / regenerate / STscript / 群聊的 ST 工作流 |
| `agent-novel` | 全自动小说推演 | DSH AgentLoop（写手子代理可选） | 先落大纲再分单元写作的长篇生产 |

三套架构并存、按聊天选择；同一份资产在哪个架构里都能用。

各模式的状态：

| 组合 | 状态 | 说明 |
|---|---|---|
| `agent-tavern` + `dsh-native` | 可用（默认） | 模型、工具调用、Stop、错误与统计全部由宿主处理；激活预设以 systemPrompt 段注入 |
| `agent-tavern` + `agent-managed` | **保持关闭** | 宿主尚未提供 `agent/context` 历史投影与 projection-aware compaction。插件不会把普通 compaction 冒充成主动遗忘，也不静默回退到伪 managed 模式 |
| 群聊 | 固定 `st` | 宿主提供可靠的 actor 元数据之前，不创建群聊 AgentTavern 会话 |

设置页会如实展示不可用模式的原因；服务端同样拒绝该组合。

## 能力地图

### 资产与 SillyTavern 兼容

- **角色卡 V1/V2/V3** — JSON、PNG `chara`/`ccv3`、CHARX `card.json` 与 `embeded://` 资源；导出尽量保留原始容器与内嵌资源；未知字段原样透传。
- **世界书 / Lorebook** — 递归扫描、副键逻辑、概率、预算、inclusion group、sticky/cooldown/delay 与位置分发。卡绑定的世界书（`extensions.world`）只在**该角色卡的会话**里自动并入，面板按实际生效状态显示勾选（「自动」徽标）；取消勾选会停用该书。手动 `activeWorlds` 仍代表用户的全局选择，插件不把链接书写进去；切换角色卡会清理旧版本残留的手动条目。
- **Chat Completion preset** — `prompts[]` / `prompt_order[]` / marker 与采样参数；context、instruct、textgen 走高级 JSON 编辑全部字段。
- **正则脚本** — ST regex 扩展形态导入，全局 + 卡级 + 预设内嵌（`extensions.regex_scripts`）合并，存量卡与预设可在面板一键回填；卡级脚本跟随角色卡、预设级脚本跟随 `activePreset`；删除角色卡会连同其卡级脚本一并移除，同名新卡不会继承旧卡脚本。同名脚本在不同来源各持一条实体（互不顶掉），面板开关可切换并提示当前是否生效，也可一键「转为全局」；正则列表按来源分区（全局 / 每张角色卡 / 每个预设），分区头提供三态总开关（一键启停该来源的全部脚本）与整段清空；`USER_INPUT/AI_OUTPUT/WORLD_INFO/REASONING` placement、`minDepth/maxDepth`、`substituteRegex`、`trimStrings`。酒馆助手的正则写面（`replaceTavernRegexes` / `updateTavernRegexesWith`）只写当前聊天的会话覆盖层，生成/预览/STscript `/regex`/浏览器展示与 AgentTavern 投影读同一份合并集合；基础资产与别的聊天不受影响。
- **STscript** — 管道、变量（聊天局部 + 全局）、`/if` 条件、随机/掷骰与聊天动作（`/send`、`/trigger`、`/regenerate`、`/cut`），composer `/` 前缀触发。
- **Prompt Template（EJS，默认关闭）** — `node:vm` 隔离执行 `<% %>`；`getvar/setvar` 族作用域变量、`[GENERATE:*]`/`[RENDER:*]` 注入、`@INJECT` 整消息插队、`getwi/getchar/getpreset` 资产读取。默认不执行卡内模板；确认信任卡作者后，在 profile 的 `dsh-soulmojito` 行配置 `templateEnabled: true` 启用，`DSH_SOULMOJITO_DISABLE_TEMPLATES=1` 可随时硬关。EJS 在插件进程内运行，`node:vm` **不是零信任沙箱**，只应对可信角色卡/世界书开启。详见 [`docs/proposals/0008-prompt-template.md`](docs/proposals/0008-prompt-template.md)。
- **Persona** — PNG 导入（内嵌描述提取）、头像、增删改、激活选择与 `position/depth/role` 注入。
- **群聊** — 成员管理、talkativeness 加权 / 列表激活、成员点触发言、`group_only_greetings`、group nudge 与 `{{group}}` 宏。
- **聊天记录** — ST JSONL（header / messages / `swipes` / `swipe_id` / `swipe_info`）；任意消息一键分支为新聊天（bookmark 回链，视图可跳回父聊天）。
- **并发保护** — 内容 revision compare-and-swap；跨标签页冲突返回 `409`，客户端重载最新内容，不静默覆盖。

### 原生 Agent 模式（AgentTavern）

- **工具面 25 件**：角色/世界书/历史/场景读面 4 件、记忆 5 件、变量 5 件、剧本 2 件、多 Agent 推演 1 件、MVU 结算 1 件、游戏 7 件。身份一律来自真实 session binding，模型无法通过参数伪造 `sessionId`、`scopeId`、角色或聊天身份。
- **记忆** — 词法检索为基线；配置 embed 来源后升级为词法 + 语义混合检索（RRF 融合）。两种来源：OpenAI 兼容远程端点（[提案 0016](docs/proposals/0016-hybrid-memory-retrieval.md)）或本地 ONNX 模型目录（[提案 0017](docs/proposals/0017-local-onnx-embed.md)，离线零网络，面板一键安装运行时）。
- **记忆维护** — 面板可对单个聊天手动发起维护 run：按原文依据合并重复事件、纠正冲突陈述、删除被证伪记录；收据记录楼面指纹与版本快照，原文再变即退役重扫。
- **变量作用域** — `turn`（单轮 scratch，回合结束清空）/ `chat` / `character` / `agent` / `global`（默认关闭，需设置开启）；写入带 expected revision CAS。
- **宿主分叉收养** — 用宿主会话菜单分叉一个 AgentTavern 会话，子会话首次运行时自动物化新 Tavern 聊天，继承 guides、变量、记忆与向量，并把继承前缀投影回填为新楼层。详见 [`decisions/2026-10-11-agent-tavern-host-fork.md`](decisions/2026-10-11-agent-tavern-host-fork.md)。
- **锚定提醒** — 首个真实用户轮注入一次性开场装载引导；此后默认每 5 turn 注入周期维护提醒，把工具职责拉回注意力。追加写在 durable log 之后永不改写，对 KV 前缀缓存透明。
- **compaction curator** — AgentTavern 会话使用 RP 检查点摘要模板（Story So Far / Characters / World Canon / Open Threads / Current Scene / Memory Maintenance / Critical Context），其余会话原样透传宿主默认摘要。
- **多 Agent 推演** — `tavern_deduce` 为 2-5 个命名角色各派生一个纯推理子 Agent，按 1-3 轮交叉站位，结论由主 Agent 织入叙事，保持单一叙事声音。
- **边界不伪装** — 缺宿主能力时保持 native 或 ST 的明确边界，不把 compaction 误称为 managed context。

### 内容生产

- **AgentNovel（全自动小说推演）** — 先落盘大纲再分单元写作，正文只经 `novel_body_commit` 原子提交；作者指令走台账 + 修订协议，冲突指令必须引用用户澄清/撤回消息才能解除。写手子代理支持 `inline | subagent` 两种模式（默认 inline）。详见 [`docs/proposals/0005-agent-novel-architecture.md`](docs/proposals/0005-agent-novel-architecture.md)。
- **原作导入续写 + 正文优化** — 导入 TXT / Markdown / EPUB 原作，服务端识别章节并按目标长度切成部分；每部分交给一次性提取子代理产出时间线、角色卡、世界书与文风，主代理熔炼成续写 bible 后走既有大纲/单元协议继续写。正文优化对已提交章节生成整章改写稿，先作为待应用版本，显式应用后进入阅读投影与导出，提交记录保持不可变。详见 [`docs/proposals/0020-novel-import-continuation-and-revision.md`](docs/proposals/0020-novel-import-continuation-and-revision.md)。
- **卡片工作台** — `dsh-soulmojito/card-workbench` preset。用对话描述想改什么，Agent 先给方案，经 diff 确认面板确认后才写入（写入工具必须携带已确认方案的 `planId`）。支持修改人物卡/世界书/预设、空白建卡、从素材或剧本提取人物制卡、card-to-mvu 转换，以及把指定聊天连同楼层范围交给工作台排错。导入时写一次原版快照，随时可恢复；写卡 Agent 落盘后写卡工作台面板自动吸收——打开面板即重取最新资产，页面可见期间按 store 变更水位（3s）轮询，写入到列表可见不需手动刷新。详见 [`docs/proposals/0013-card-workbench.md`](docs/proposals/0013-card-workbench.md)。
- **剧本游玩** — TXT/Markdown/EPUB 导入为剧本资产，自动分块，与人物卡一对一绑定，新开局按剧本推进；只按进度召回附近片段，不整本注入上下文。剧本块是参考不是约束：玩家可偏离，只有正文实际覆盖当前片段关键事件才推进进度。详见 [`docs/proposals/0014-script-play.md`](docs/proposals/0014-script-play.md)。

### 对话交互增强

- **持续指引（Guides）** — 把长期生效的写作/节奏要求（如「多写心理活动」「好感度涨得慢一点」）存为 Guide，本局正文、行动候选与带意见重写自动参考。上限 8 条、单条 ≤500 字符，删除即时生效，正文中不回显。[提案 0009](docs/proposals/0009-conversation-guides.md)
- **行动候选** — 一键生成 3-6 个「人物行动 / 场景变化」候选，点击填入输入框（可改再发）或带反馈重新生成。候选是建议不是指令，没有自动执行路径。[提案 0010](docs/proposals/0010-turn-candidates.md)
- **带意见重写** — 对当前轮回复附一句修改意见后重写，结果作为新 swipe 追加，可左右切换比较；意见只存在于该次请求与 swipe 元数据，不落盘为聊天楼层。[提案 0011](docs/proposals/0011-rewrite-with-feedback.md)
- **思考 + 正文双通道流式** — reasoning 增量实时流式显示、保存后可折叠回看，各 swipe 候选的思考随切换跟随。详见 [`decisions/2026-10-11-st-reasoning-stream.md`](decisions/2026-10-11-st-reasoning-stream.md)。
- **MVU 变量结算** — 变量由后台按卡内规则做**确定性脚本结算**（与 flizzywine 的后台 LLM 结算是不同的架构选择，日常结算零额外模型开销）。每轮产出回执（每项变更前后值、原因、失败项），失败项可单独重试而不动正文；固定状态栏由变量渲染，不随流式生成掉格式；回执可撤销（newest-first 链）。变量树可选 `$schema` 写入守卫（结构/类型锁定、`$range`/`$step` clamp、`$enum` 拒绝、`$ro` 只读）与 `$rules` 条件规则（阈值触发、派生值、连锁修正）。[提案 0012](docs/proposals/0012-mvu-settlement.md) · [`decisions/2026-10-11-mvu-schema-guard.md`](decisions/2026-10-11-mvu-schema-guard.md)
- **提示词查看器** — 查看 ST 生成循环每轮**实发给 LLM 的最终请求**（pre-llm 改写之后）与世界书激活轨迹；Agent 模式记录插件预注入面（systemPrompt 分面、本步注入消息、agent/request 链尾实发参数）。进程内环形缓冲：每聊天最近 10 条、总量 50，记录失败绝不影响生成。详见 [`decisions/2026-10-11-prompt-viewer.md`](decisions/2026-10-11-prompt-viewer.md)。
- **试写预览** — 选定聊天与一句用户语，按当前激活预设/人设/世界书完整装配后跑一次真实生成，零副作用：不落楼、不结算、不触发事件。详见 [`decisions/2026-10-11-preview-generation.md`](decisions/2026-10-11-preview-generation.md)。

### 游戏与 Mod 扩展

- **Agent 游戏桥** — 标准游戏引擎契约（`game.json` 清单 + 零依赖纯函数 `engine.mjs` + 自包含 `view.html`），三源注册（内置 / 导入 / Mod）。棋盘自动显示在与 MVU 状态同位处；Agent 在自己回合内用阻塞等待挂起，人类落子跨 bundle 写穿唤醒，**用户无需发送聊天消息触发下一步**。游戏包可直接从面板导入（zip 上传 / git 安装），制作指南见 [`docs/games/game-package.md`](docs/games/game-package.md)，设计契约见 [`docs/proposals/0018-agent-game-bridge.md`](docs/proposals/0018-agent-game-bridge.md)。
- **九款内置游戏** — 井字棋、五子棋、中国象棋、军棋、21 点、记忆翻牌对战、大富翁、地牢爬行、中国跳棋，开箱可玩。
- **游戏工具 7 件** — `game_list` / `game_start` / `game_state` / `game_history` / `game_move` / `game_wait` / `game_wait_full`，按 token 经济设计：读归读、写归写，wait/move 只回增量。
- **Mod 扩展接口** — 把带 `mod.json` 的目录放进 `$DSH_HOME/soulmojito/mods/`（旧安装仍是 `$DSH_HOME/tavern/mods/`；或面板内 git 一键安装）即可被识别，默认禁用。首启弹确认层如实展示声明的能力面（知情同意，含无沙箱告知）。启用后可注册：五相位生成 hook（user-input / pre-assemble / pre-llm / post-output / post-save，顺序 waterfall，抛错/超时/忘 return 统一降级不中断生成）、Agent 工具（强制 `<modId>_` 前缀，与内置工具三层查重，冲突即拒）、宿主宏与 STscript 命令、prompt 分区（order 钳制 -50..0）、配额存储（单值 256KB / 总量 1MB）、HTTP 子路由、沙箱化面板 UI（`sandbox="allow-scripts"`，无 same-origin，CSP `connect-src 'none'`）。坏 Mod 只记审计跳过、不拖垮本体；禁用/卸载全注册面回收，全部装载与调用行为落审计日志；`DSH_SOULMOJITO_DISABLE_MODS` 可硬关整个 Mod 系统。Mod 还可声明按钮（manifest `buttons` → 面板与 ST 聊天视图渲染 chip，点击分发到 `api.onButton`）、接收本客户端写入的下行事件推送（聊天保存/资产保存/guides/按钮点击），Mod UI 的 console 输出自动回投宿主的 per-mod 日志查看器。开发者文档见 [`docs/mods/mod-api.md`](docs/mods/mod-api.md)，官方示例覆盖 v1 全部能力面。
- **示例 Mod** — 四个官方示例覆盖 v1 全部能力面：[`asset-stats`](packages/plugin/examples/mods/dsh-soulmojito.asset-stats)（资产只读统计）、[`mood-tracker`](packages/plugin/examples/mods/dsh-soulmojito.mood-tracker)（post-output hook + 情绪工具对 + iframe 面板）、[`story-clock`](packages/plugin/examples/mods/dsh-soulmojito.story-clock)（聊天变量 `clock` + `{{clock}}` 宏 + `/clock` 命令族 + `llm` 门控摘要）、[`rps`](packages/plugin/examples/mods/dsh-soulmojito.rps)。

### Tavern 管理面板

两栏布局（左侧导航 + 右侧内容），窄屏折叠为横向滚动栏；导航品牌块常驻不滚，分区清单独占滚动。19 个分区：

| 分区 | 内容 |
|---|---|
| 总览 | 当前角色 / 预设 / 人设 / 世界书开关与各类资产数量 |
| 角色卡 / 世界书 / 预设 | 导入（PNG / CHARX / JSON）、编辑、搜索、设为当前、导出、删除；保存经服务端格式校验后写回 `$DSH_HOME/soulmojito/`（旧安装写回 `tavern/`） |
| 聊天 / 群组 / 人设 / 持续指引 / 正则 / 变量 | 各资产的管理面，从设置页统一归位到这里 |
| 小说 / 剧本 | AgentNovel 小说库；剧本资产的分块、绑定与进度 |
| 工作台 | 方案确认入口（逐字段 diff → 批准并应用 / 拒绝）与试写 |
| 行为设置 | 全部系统行为开关，按行为对应关系分组（会话 / 世界书 / 工具写入 / 前端与卡脚本 / 游戏）；设置页同步展示同一面 |
| 游戏 / Mod | 游戏清单与对局面、游戏包导入（zip 上传 / git 安装）；Mod 清单、能力声明 Pill、两层开关、git 安装与审计计数 |
| 记忆检索 | embed 来源三态（关闭 / 远程 / 本地）与探针 |
| 提示词 | 实发请求 + 世界书激活轨迹的只读查看器 |
| 关于 | 版本 stamp 与官网 / 源码外链 |

角色卡、世界书、预设、正则脚本与用户人设的编辑器在独立弹窗中打开，显示未保存状态；取消离开时提示确认，页面关闭提供浏览器级离开保护。

入口是 DSH 原生侧栏底部的 SoulMojito 按钮（自绘品牌图标），或「设置 → DSH-SoulMojito」。品牌图标是 [`assets/logo.svg`](assets/logo.svg)，同一组件落四处：面板品牌块、侧栏按钮、设置页入口、面板「关于」分区头部。

### 与 DSH 的原生集成

插件不替换 DSH 原生表面，而是挂进官方 slot：

| DSH slot | 用途 |
|---|---|
| `conversation.view` | Tavern JSONL transcript |
| `conversation.composer` | Tavern session 的 RP 输入框、模型选择与 Stop |
| `conversation.session.header.actions` | 当前角色、regenerate 与原生 session stats |
| `settings.section` | Active setup 快速切换与面板入口 |
| `shell.overlay` | Tavern 管理面板 Modal，以及侧栏聊天树 adapter 的生命周期承载 |
| `sidebar.footer.action` | 常驻 Tavern 面板按钮，与原生 Settings 并列 |
| `sidebar.right.pane.tab` | MVU 状态、游戏对局、美化前端与卡脚本右栏 tab |

- **每聊天一个正式会话** — 每个 Tavern 聊天绑定一个正式 DSH session；view/composer/标题栏只接管带有效 Tavern marker 的会话，普通 DSH 会话保持原生表面。生成循环把 turn/step、流式 chunk、assistant message 与 provider usage 镜像进同一 session，因此标题栏直接复用宿主的 `sessionStats` / `tokenUsage` projection。
- **Composer 模型选择** — 复刻 DSH 原生 model seat 的 provider 分组目录与 Effort 二级菜单，按 session 持久化，未选择时回落 DSH 默认模型。
- **内部工作区** — ST 与 AgentTavern 新聊天共用数据根下 `workspace/`（新装 `$DSH_HOME/soulmojito/workspace/`，旧装 `$DSH_HOME/tavern/workspace/`）的 `Tavern (internal)` 工作区，插件按 workspace 路径/ID 从原生侧边栏隐藏该分组。宿主 `rc.6` 没有可追加到原生 session tree 的正式 list slot，侧栏因此使用一个集中、版本敏感但**失败关闭**的 DOM adapter（只匹配可见左侧 `[role="tree"]`，解绑或卸载时可逆恢复）；面板入口本身走官方 slot，不依赖 adapter 是否挂载成功。
- **语言** — 插件 UI 跟随 DSH 的语言设置（zh/en），切换后无需刷新即时生效。
- **当前配置与行为设置** — 「当前配置」只留角色 / 预设 / 人设 / 压缩总结模型的快速切换；全部行为开关收进面板「行为设置」分区（system 组置顶，原生设置页同步展示同一个 band），按行为对应关系分组：会话行为（`defaultArchitecture` 新聊天架构、`defaultContextMode` AgentTavern 上下文、`preloadAssets` 新 AgentTavern 会话开始时一次性预载角色信息与常驻世界书条目（默认关闭且不追溯已有会话）、`nativePersona` 在标准 DSH Agent 会话中使用当前角色（默认关闭））、世界书行为（`worldFollowsCharacter` 世界书跟随角色卡激活——绑定的书只在所属角色卡的会话里自动生效，不写入手动 `activeWorlds`）、工具写入（`allowGlobalWrites` 允许工具写 global 作用域，默认关闭）、前端与卡脚本（`frontendAutoOpen` 美化前端出现时自动打开右侧栏（默认关闭，每聊天一次）、`frontendAllowExternalResources` 允许美化前端加载外部资源（默认关闭）、`cardScriptsAutoRun` 进入聊天自动运行卡内全部启用脚本（默认关闭））、游戏行为（`gamesDisableResign` 禁用投降）。全部开关服务端逐次读取、即时生效。设置页标题下显示当前构建的版本与 commit。

### 美化前端（消息内 HTML/JS）

把完整 HTML 文档、`<head>`/`<body>` 片段放进助手消息，或使用 `html` Markdown 代码块，消息保存后会在隔离 iframe 中运行；流式生成与编辑时仍显示源码，避免半成品脚本被重复执行。

- 完整文档：`<!doctype html>...`，或同时包含 `<html>` 与 `<head>`/`<body>`。
- HTML 片段：包含 `<head>` 或 `<body>`；缺外壳时运行时自动补齐 `doctype`、viewport 与基础样式。
- Markdown 代码块：语言标记写 `html`。

每个前端使用 `sandbox="allow-scripts"` 且**不授予 `allow-same-origin`**：脚本不能读写宿主 DOM、Cookie、`window.parent` 或 DSH API（高度回传与助手兼容层都只走受校验的 `postMessage`）。CSP 允许内联 CSS/JavaScript 与这些静态源：`cdn.jsdelivr.net`、`testingcf.jsdelivr.net`、`cdn.tailwindcss.com`、`cdnjs.cloudflare.com`、`unpkg.com`、`esm.sh`、`fonts.googleapis.com`、`fonts.gstatic.com`；图片、字体与媒体可用 `https:`、`data:` 或 `blob:`。设置页「允许美化前端加载外部资源」默认关闭；开启后 iframe 额外放行任意 HTTPS 脚本/样式，并把 `connect-src` 放宽到 `https: blob:`（`fetch`/XHR、CDN sourcemap 与卡自己生成的 blob URL 可用）——外部脚本因此能读取前端可见的聊天内容并外发，只对信任的卡开启。卡没有设置背景时，iframe 画布用 DSH 原生背景色（`--dsw-alias-bg-base` 的解析值）填充，并在主题切换时即时更新——深色模式不会出现一圈白边；卡内自己的 `html`/`body` `background` 仍然按 cascade 覆盖。**不支持**：嵌套 iframe、`object`/插件、表单提交。自动高度由 `ResizeObserver` 回传并限制在 80-4000px；也可以拖动前端底部的把手手动调整（120-4000px，双击或按 Home 回到自动高度，手动高度优先于卡的 `frame.prefs`）；TUI/headless 显示原始消息文本，不执行脚本。

AgentTavern 架构的对话是宿主原生表面，插件没有消息正文 slot：同一份美化前端改由 DSH **原生右侧栏**的「美化前端」tab 承载——取本聊天**最新一条**带完整 HTML 的楼层（标题行显示楼层号），随聊天 5s 可见性轮询更新；标题栏按钮与右栏「+」guide 都能打开。右栏标题行的展开按钮把面板铺成视口大小的浮层（再点或按 Esc 收起），刷新按钮重新拉取并重挂 iframe，卡前端的内存状态会随之重置。设置页可开启「美化前端出现时自动打开右侧栏」（默认关闭，每聊天只自动展开一次）。ST 架构仍在消息里内联渲染，侧栏只显示说明空态，不重复执行脚本。开启 `cardScriptsAutoRun` 后，AgentTavern 的卡脚本自动运行也落在这一份 iframe 里：全部启用脚本按脚本树顺序注入最新楼层里**文档长度最大的**那个完整 HTML（同长度取最后一个；行动栏这类小框不抢脚本宿主；该楼层没有 HTML 时给脚本一个独立画布），悬浮按钮 / GM 面板直接叠在美化前端上，并与前端共享 DOM、主题和 helper 通道；每段脚本注入 per-script scope，`getScriptId`/`getScriptName`/`getScriptInfo` 与按钮 API 按所属脚本归属，按钮条显示在美化前端 tab；出现新的美化楼层时整份文档重建，脚本随之重启。[决策](decisions/2026-10-20-frontend-sidebar.md)

**卡脚本 tab**：卡内 `extensions.tavern_helper.scripts`（JSR 的常驻脚本树）**默认不自动执行**。右栏「卡脚本」tab 是脚本容器：列出全部脚本（含禁用项），每个脚本运行在**自己的**沙箱 `FrontendFrame` 里，带 `scriptId`/`scriptName`/`scriptInfo`；脚本上报的按钮渲染为容器按钮条，点击回投 `eventOnButton` 事件。切换聊天/角色立即停止并清空。列表来自**当前聊天的会话脚本树副本**，所以运行的是 GM 面板改写过的最新源码。设置页开启 `cardScriptsAutoRun`（默认关闭）后：**AgentTavern** 聊天不再自动展开本 tab，自动运行改由「美化前端」承载（脚本注入最新楼层 HTML 的同一个沙箱 iframe，与前端共享 DOM/主题与全局变量；每段脚本的 per-script scope 让身份/按钮归属正确，按钮条在美化前端 tab；没有 HTML 楼层时给脚本一个独立画布），本 tab 只保留列表、重置与手动入口，自动运行开启时手动运行禁用；**ST** 聊天仍自动展开本 tab，并按脚本逐个 iframe 自动执行。无论哪种架构，脚本都拥有当前聊天的变量、消息、会话世界书副本与会话脚本树副本写权限，只对信任的卡开启；tab 内可「停止自动运行」（ST）或回到手动模式。面板顶部常驻警告。[决策](decisions/2026-10-21-card-scripts-host.md) · [脚本容器决策](decisions/2026-10-23-jsr-surface-parity.md)

**会话世界书副本**：脚本通过 `getWorldbook` / `updateWorldbookWith` 读写的世界书只落在**当前聊天**的覆盖层（`chats/<角色>/<聊天>.jsonl.worlds.json`）；基础 `worlds/<name>.json` 与卡内 `character_book` 保持只读。当前聊天的世界书激活、生成与 MVU 读取优先用副本；副本随聊天生命周期（重命名跟随、分支/分叉复制、删除清理），跨聊天互不影响。「卡脚本」tab 底部的「重置会话世界书」丢弃副本、回到角色卡原版。[决策](decisions/2026-10-21-card-scripts-host.md)

**会话脚本树副本**：GM 面板用 `updateScriptTreesWith` 改写的 Zod 源码按聊天持久化到 `chats/<角色>/<聊天>.jsonl.scripts.json`——先 `scripts.put` 落盘，成功后才更新 iframe 内存并发布 `mg-zod-ready`；刷新页面或重开卡脚本 tab 仍从副本起步，不回写角色卡、不影响别的聊天。持久化的是**脚本源码**，服务端 MVU 仍不执行 Zod；卡脚本 tab 的「重置卡脚本」删除副本并回到卡原版。[决策](decisions/2026-10-21-card-scripts-host.md)

**酒馆助手兼容层**：JSR 4.11.3 的 179 个公共名全部安装（`window` 与 `window.TavernHelper` 同一函数对象，`getTavernHelperVersion()` 返回 `4.11.3`）：变量/楼层/事件/音频、真实预设与人设读取、世界书条目族、脚本容器（`getScriptInfo`/`replaceScriptInfo`/`getAllEnabledScriptButtons`/三来源 `getScriptTrees`）、同步宏展开（`substitudeMacros`）与同步正则（`getTavernRegexes` / `formatAsTavernRegexedString`）都可用；并内置 lodash、jQuery、showdown 与 YAML（yamljs）。**沙箱不变**：所有调用经 token 校验的 `postMessage` 交给宿主代理，再由宿主按当前会话绑定访问 store——iframe 拿不到宿主对象，也不能指定别的角色/聊天。变量可写 `global`/`chat`/`message`/`character`：`character` 写入 `state.json` 的 `characterVariables[角色名]` 覆盖层，角色卡文件保持只读，删掉该键即回到卡原版；AgentTavern 会话的 chat 变量同时写入 `chat_metadata.variables` 与 MVU 的 chat 作用域，避免两份状态漂移。世界书写面 `updateWorldbookWith` 只写会话副本；`getCharWorldbookNames` 同步返回卡链接世界。`SillyTavern.saveChat` / `saveSettingsDebounced` / `extensionSettings` / `chatCompletionSettings` 是 iframe 侧兼容 shim（真实写盘仍走 helper RPC）。**生成与命令**：`generate` 支持 `should_stream:true`，宿主把增量转成 `iframe_events.STREAM_TOKEN_RECEIVED_INCREMENTALLY/FULLY`，最终 Promise 仍返回完整文本；`stopGenerationById` / `stopAllGeneration` 通过宿主 `AbortController` 真正中止；`/stop` 同时中止 ST 主生成与卡内生成桥，`/regenerate` 仅在 ST 架构且宿主空闲时可用（AgentTavern 显式报错）。**明确不支持**：角色卡写入、扩展安装、基础世界书新建/删除（世界书条目与整书改走**会话副本**）、预设删除/改名/激活、**基础正则资产写入**（`replaceTavernRegexes` / `updateTavernRegexesWith` 只写本聊天的会话覆盖层，生成/展示/投影读同一份合并集合）、宿主消息 DOM（`retrieveDisplayedMessage`/`refreshOneMessage`）——调用即抛带原因的 error，不静默跳过；`generate` 仍要求卡内 `custom_api`，不走 ST 预设管线；`/trigger` 仅支持本 iframe 刚创建的那条用户楼层，桥接层会把它替换成一次宿主 composer 发送，避免重复楼层。

**MagVarUpdate / Mvu 兼容（2026-10-21）**：Agent 模式投影器会解析模型回复末尾的 `<UpdateVariable><JSONPatch>`，按宽松 RFC 6902（`replace`/`insert`/`delta`/`remove`，自动补中间对象、`当前/最大` clamp）写入 `chat_metadata.variables.stat_data`，并把每楼快照挂到 `variables.stat_data`；卡内 `StatusPlaceHolderImpl` 自动补齐，展示层正则即可挂载状态栏。前端可直接用 `Mvu.getMvuData` / `Mvu.replaceMvuData` / `Mvu.events.VARIABLE_UPDATE_ENDED`，`toastr` 与 `window.parent` facade（`#send_textarea` / `#send_but`）也已补齐；`mvu.replace` 成功后宿主重投快照，按钮改值会同步到同聊天的状态栏 iframe。`tavern_helper.scripts` 脚本树仍不自动执行，需要时从右栏「卡脚本」tab 手动运行；详见 [`docs/frontend/tavern-helper-compat.md`](docs/frontend/tavern-helper-compat.md)。Agent 模式每轮还会把卡内 constant EJS 世界书按当前变量渲染成一条插件消息注入（首轮全量，后续只补变化，每 8 轮全量刷新），让 `<UpdateVariable>` 协议、阶段指令与事件处理器真正进入模型上下文。

完整的**可用 / 部分可用 / 不可用**清单（含每个函数的作用域、事件是否真的会触发、常见 JSR 写法的替代方案、报错对照表）见 [`docs/frontend/tavern-helper-compat.md`](docs/frontend/tavern-helper-compat.md)。[决策](decisions/2026-10-20-frontend-helper-compat.md)

## 快速开始

要求 **Node.js 22+**，并已安装 DSH。

### 安装

```sh
git clone https://github.com/LingyeSoul/DSH-SoulMojito.git
cd DSH-SoulMojito
pnpm install
pnpm run build:plugin
dsh plugin --profile web add ./packages/plugin
dsh --profile web
```

桌面版（`desktop` profile）在「设置 → 插件 → Git 仓库」填子目录 spec：

```sh
github:LingyeSoul/DSH-SoulMojito#path:/packages/plugin
```

也可以直接命令行安装到 desktop profile：

```sh
dsh plugin --profile desktop add github:LingyeSoul/DSH-SoulMojito#path:/packages/plugin
dsh --profile desktop
```

> spec **必须**落到 `packages/plugin`：仓库根是 monorepo 容器，不声明 `dsh.bundle.patch`，插件管理器会以「这个包没有声明组合包，不能作为插件管理」拒绝并回滚配置。已有源码检出时也可挂本地绝对路径。
>
> git spec 固定到安装时的提交、不跟随源码更新；`version.json` 不纳入 Git，设置页显示的是构建期注入的版本与 commit。
>
> 默认只接受 loopback 与宿主绑定的 Host。局域网、反向代理或自定义域名部署时，在 profile 的 `dsh-soulmojito` 行配置 `allowedHosts`（`host` 或 `host:port`，不支持通配符）；Origin 与 Content-Type 检查不会因此放宽。配置示例见 [`packages/plugin/README.md`](packages/plugin/README.md)。

### 首次使用

1. 点击侧栏底部的 SoulMojito 按钮（或「设置 → DSH-SoulMojito」）打开管理面板。
2. 在「角色卡 / 世界书 / 预设」分区导入资产；导入后可直接编辑、保存、搜索、设为当前或导出。
3. 在设置中选择新聊天架构（单角色新聊天默认 AgentTavern/native，群聊始终 ST）。
4. 在左侧 Tavern 分支展开角色并创建或打开聊天：AgentTavern 使用 DSH 原生 conversation，ST 使用原生 `Tavern` tab。
5. ST 聊天里验证编辑、swipe、regenerate 与 STscript；AgentTavern 聊天里验证原生 composer、工具调用、Stop 与会话统计。

### 验证

```sh
pnpm run check
```

该命令依次跑 `tsc -b`、vitest 全量、`build:plugin` 与 15 个插件 gates，是提交前的唯一权威口径。

## 更新

### 仓库重建（2026-10-22）

2026-10-22 仓库做过一次历史重写并重建：旧历史中的第三方卡夹具（角色卡 PNG 与世界书 JSON）已从全部提交移除，所有受影响的 commit SHA 都已变化。旧仓库已删除，旧的 issue、PR 与提交链接不再有效。

- **旧克隆**：不要 `git pull`，也不要把旧分支合并回来——旧历史仍带已移除素材，推送会把它们带回远端。请重新 `git clone`；必须保留本地改动时，先导出补丁，再在新克隆上重放。
- **已安装插件**：自更新按 main 最新 commit 判定，重建后重新检查更新即可。若 profile 仍指向失效的旧 checkout，移除后按当前仓库地址重装：

```sh
dsh plugin --profile web remove dsh-soulmojito
dsh plugin --profile web add github:LingyeSoul/DSH-SoulMojito#path:/packages/plugin
```

桌面版把 `--profile web` 换成 `--profile desktop`。数据目录与既有资产不受影响；`version.json` 的 commit stamp 以重建后的提交为准。完整处置记录见 [`decisions/2026-10-22-history-rewrite-and-repo-rebuild.md`](decisions/2026-10-22-history-rewrite-and-repo-rebuild.md)。

### 内置自更新

插件自带从 GitHub 发现新版本与一键更新，桌面版不必手敲 `dsh plugin`。

- **发现** — 「设置 → DSH-SoulMojito」标题下与管理面板「总览」显示当前构建、GitHub 最新构建、待合入的 commit 列表与上次检查时间。启动后延迟 12s 首查、每 6h 复查，结果缓存在数据根的 `update-state.json`（新装 `$DSH_HOME/soulmojito/`，旧装 `$DSH_HOME/tavern/`）；「检查更新」按钮穿透缓存立即查。
- **判定** — 仓库不发 release/tag，以 main 分支最新 commit + `packages/plugin/package.json` 的 version 为准。
- **落地** — 「立即更新」按 `dsh plugin` → 宿主 `plugin-manager` 服务 → GitHub checkout 覆写的顺序执行，进度日志实时显示。三条路径都**需要重启 DSH**：包替换要新的 JS module generation，宿主 HMR 不监听 `node_modules`。
- **来源降级** — `api.github.com` → `raw.githubusercontent.com` + `git ls-remote` → commits atom feed；每个 HTTP 请求在 fetch 失败后自动用系统 `curl` 重试（企业 TLS 中间人会让 node 的证书校验失败）。
- **开关** — profile 的 `dsh-soulmojito` 行写 `checkForUpdates: false`，或设 `DSH_SOULMOJITO_DISABLE_UPDATE_CHECK=1`；`DSH_SOULMOJITO_DISABLE_CURL=1` 关闭 curl 兜底；`GITHUB_TOKEN`/`GH_TOKEN` 可提高 GitHub 限流配额。
- **HTTP 端点** — `GET /api/dsh-soulmojito/update`（缓存快照，`?refresh=1` 穿透 TTL）、`POST .../update/check`、`POST .../update/install`（`{ "wait": false }` 立刻返回，进度轮询 `GET update`）。

实现细节与实测证据见 [`decisions/2026-10-05-desktop-plugin-self-update.md`](decisions/2026-10-05-desktop-plugin-self-update.md)。

### 源码检出

`dsh plugin add` 以本地 link 方式挂载插件，代码更新后重新构建并重启即可：

```sh
git pull
pnpm install
pnpm run build:plugin
dsh --profile web
```

依赖残留或版本不一致时，移除后重新添加：

```sh
dsh plugin --profile web remove dsh-soulmojito
dsh plugin --profile web add ./packages/plugin
```

已安装插件建议使用 plugin-registry 的薄控制台管理 profile 中的 bundle 层栈、insert 行与启停状态，避免手改配置（`<plugin-registry>` 替换为该工具仓库的本地路径）：

```sh
dsh plugin --profile web add <plugin-registry>/packages/plugin/console
```

### 从旧名迁移（dsh-tavern → DSH-SoulMojito）

2026-10-16 项目改名：包名 `dsh-tavern` → `dsh-soulmojito`、工作区 `@dsh-tavern/*` → `@dsh-soulmojito/*`、插件挂载名与 API 前缀同步更名。存量安装与数据**读取端兼容**，一次性动作只有「换包名重装」：

```sh
dsh plugin --profile web remove dsh-tavern
dsh plugin --profile web add ./packages/plugin
```

- GitHub 旧地址自动重定向到新仓库，存量安装的自更新链路不断。
- 数据目录（改名前后都是 `$DSH_HOME/tavern/`；2026-10-21 起新装迁到 `soulmojito/`，旧目录原地兼容，见下节）与既有资产零迁移；旧写入标记（`dsh-tavern` / `plugin:dsh-tavern`）、旧环境变量（`DSH_TAVERN_*`）、旧游戏命名空间 id（`dsh-tavern.*`）与新名双认——老会话、老对局、老配置行为不断。
- 新写入与新文档一律用新名；旧名只作读取兼容存在。完整映射见 [`decisions/2026-10-16-project-rename-dsh-soulmojito.md`](decisions/2026-10-16-project-rename-dsh-soulmojito.md)。

### 存储目录（2026-10-21）

数据根从 `$DSH_HOME/tavern/` 迁到 **`$DSH_HOME/soulmojito/`**：

- **新装**直接使用 `soulmojito/`。
- **存量安装**继续读写 `tavern/`——解析在新目录非空时用新目录，否则旧目录非空时用旧目录。不自动搬迁：宿主 workspace 注册表与原生 session 目录都按旧路径登记（`sessions/--…-dsh-tavern-workspace--/`），rename 会让已绑定会话的 cwd 消失、旧工作区变悬空条目。
- 两个目录都有数据时新目录优先（显式搬迁后的生效路径）；空的 `soulmojito/` 目录不会遮蔽存量库。
- 完整理由与否决项见 [`decisions/2026-10-21-storage-dir-soulmojito.md`](decisions/2026-10-21-storage-dir-soulmojito.md)。

## 架构与代码结构

### 包结构

| Package | 说明 |
|---|---|
| `@dsh-soulmojito/format` | 卡、PNG/CHARX、世界书、preset、群组文件、regex 脚本与 chat JSONL 的解析与无损往返 |
| `@dsh-soulmojito/lore` | World Info 激活与 timed effects 引擎 |
| `@dsh-soulmojito/macros` | 角色、时间、随机、变量等宏引擎 |
| `@dsh-soulmojito/pipeline` | preset 顺序、lore、persona、历史与 token budget 的 prompt 装配（chat completion + 群聊回合） |
| `@dsh-soulmojito/script` | ST regex 脚本执行器与 STscript 解释器 |
| `@dsh-soulmojito/store` | `$DSH_HOME/soulmojito/`（旧装 `tavern/`）原子文件存储、revision 与 session binding |
| `@dsh-soulmojito/template` | EJS Prompt Template 引擎：`node:vm` 沙箱执行、作用域变量与内容注入 |
| `@dsh-soulmojito/bind` | 跨 DSH 版本的宿主形状兼容层：会话事件探测、宿主包锚解析、client 连接双面回退与宿主形状诊断 |
| `@dsh-soulmojito/jsr` | 酒馆助手（JS-Slash-Runner）兼容运行时：iframe shim 源文本、事件词汇表、库全局与 postMessage 协议；宿主域操作仍由插件适配 |
| `@dsh-soulmojito/frontend-storage` | 沙箱美化前端存储：虚拟 localStorage/sessionStorage/IndexedDB shim、二进制传输、宿主侧记录存储与按角色持久化规则 |
| `dsh-soulmojito` | 插件本体（Node half + Web client half + 随附示例 Mod 与游戏） |

### 构建产物

Node half 是六个自包含 bundle：`index.mjs` 主入口，加 `agent` / `compaction` / `novel` / `card-workbench` / `reasoning` 五个子代理入口（见 `packages/plugin/package.json` 的 `exports`；`reasoning` 是内部无工具推理组合，DSH 0.2.1+ 的 spawn 子代理隔离面）。所有 `@dsh-soulmojito/*` 工作区库全部内联，**无运行时依赖**，不需要用户额外安装公共 `@deepseek-ai/*` 运行时依赖；client closure 由 DSH profile 注入。

这些产物**有意入库**：仓库不发 release/tag，git spec 安装与自更新 checkout 兜底都以分支头为发布通道，产物不入库即装完即坏。唯一例外是 `version.json`（带本地 commit 戳，每次构建不同，不入库）。

### 适配新宿主版本时

跨版本兼容层集中在 `packages/bind`，更新版本适配**先改这里**。client half 的源文件是 `packages/plugin/client-src/` 的分片（按 `manifest.json` 拼接为 `client/main.js`）；`client/index.js` 是 `build:plugin` 的产物，把 bind 探测模块、JSR 运行时与沙箱存储库分别注入 `__DSH_BIND_CLIENT_SLOT__`、`__DSH_JSR_CLIENT_SLOT__`、`__DSH_FRONTEND_STORAGE_CLIENT_SLOT__` 标记处。生成物不要手改，改了会被下次构建覆盖。

插件激活时输出一行 `dsh-soulmojito host shape: {...}` 日志，报告命中的宿主形状绑定路径——排查宿主版本差异从它读起。

## 测试与质量基线

```sh
pnpm run check
```

当前基线（2026-10-24 实测）：

```
Test Files  136 passed (136)
Tests       2062 passed | 1 skipped (2063)
18 gates    全部 PASS
built       v0.7.0 (d128066)
```

- 1 项跳过是 `skipIf` 环境条件项：Windows 检出上的 `host-package.spec.ts` POSIX-only 用例。
- 18 个 gates 覆盖 update-routes、package-contract、patch-reference、server-bundle、client-bundle、frontend-runtime、native-header-adapter、mvu-surface、frontend-surface、client-architecture-split、internal-workspace、agent-tavern-isolation、client-vm-mount、node-half-mount、v4-session-admission、mod-loader、content-lexicon 与 source-file-budget。
- 完整 `pnpm run check` 需要可解析 DSH 官方运行时；本仓库验证使用隔离 runtime（`.npm-cache/dsh-runtime`，受限环境依次回落 `NODE_PATH` 与全局安装）。
- 会话事件写入的宿主契约（V4 关系准入、assistant 结算 `usage`/`stream`）由 `packages/plugin/tests/agent-tavern-session-admission.spec.ts` 直接对真实宿主代码回归。
- 示例 Mod 的 engines 与随仓库发布的宿主版本由防漂移守卫锁定（先例：[`decisions/2026-10-12-story-clock-engines-drift.md`](decisions/2026-10-12-story-clock-engines-drift.md)）；面板布局、品牌 logo 与内置游戏规则面同样各有 spec + gate marker 锁定。

GUI 已在桌面与 390x844 移动视口验证，覆盖原生 sidebar、管理面板、资产编辑器、conversation view/composer、流式生成、Stop、edit、swipe、regenerate、rename/delete 与 revision 冲突。

## 文档

项目文档按四类分放，**完整索引见 [`docs/README.md`](docs/README.md)**：

| 目录 | 内容 |
|---|---|
| [`docs/proposals/`](docs/proposals/) | 18 篇架构级设计契约（提案 0001-0018），实现后在此登记 |
| [`decisions/`](decisions/) | 107 篇单次落地决策：问题、方案、否决项、与规格的偏差 |
| [`docs/exploration/`](docs/exploration/) | 调研归档，结论必须带证据坐标（文件:行号） |
| [`docs/plans/`](docs/plans/) · [`docs/adr/`](docs/adr/) · [`docs/mods/`](docs/mods/) · [`docs/games/`](docs/games/) | 施工计划 · 架构决策记录 · Mod 开发者文档 · 标准游戏包制作指南 |

从这几篇读起：

- [`docs/proposals/0001-tavern-architecture.md`](docs/proposals/0001-tavern-architecture.md) — 当前架构、边界与后备路线。
- [`docs/proposals/0004-agent-tavern-architecture.md`](docs/proposals/0004-agent-tavern-architecture.md) — AgentTavern 原生 AgentLoop 架构、记忆/变量工具、遗忘策略。
- [`docs/proposals/0018-agent-game-bridge.md`](docs/proposals/0018-agent-game-bridge.md) — 游戏桥标准与权威状态论证。
- [`docs/games/game-package.md`](docs/games/game-package.md) — 标准游戏包制作指南（三件套、引擎契约、视图桥、打包导入与排错）。
- [`CONTEXT.md`](CONTEXT.md) — 项目架构语言的统一词表（AgentTavern / ST 架构 / 上下文 / 记忆 / 遗忘 / 作用域），动手前先读。
- [`docs/exploration/2026-10-11-jsr-lwb-reference.md`](docs/exploration/2026-10-11-jsr-lwb-reference.md) — 竞品参考与不复刻清单。

## 内容边界

本工具面向 18 岁及以上用户。禁止涉及未成年人的性内容、非自愿性内容与真实人物性化内容；模型输出与导入资产由使用者负责。完整边界、数据责任与兼容标识说明见 [`docs/content-policy.md`](docs/content-policy.md)。

## 许可

GPL-3.0。项目只实现公开规范和可观察行为语义，不复制 SillyTavern 的 AGPL 源码。Fabric 与 dsh-ads 仅用于架构调研，第一版运行时不依赖它们。
