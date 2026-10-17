<p align="center"><img src="assets/logo.svg" alt="DSH-SoulMojito logo" width="112"></p>

<h1 align="center">DSH-SoulMojito</h1>

<p align="center">把 DSH（deepseek-harness）扩展成兼容 SillyTavern 生态的原生角色扮演工作区。</p>

<p align="center">
  <strong>v0.6.6</strong> · 面向 DSH <code>0.2.0-rc.2</code> · GPL-3.0
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
- **世界书 / Lorebook** — 递归扫描、副键逻辑、概率、预算、inclusion group、sticky/cooldown/delay 与位置分发。
- **Chat Completion preset** — `prompts[]` / `prompt_order[]` / marker 与采样参数；context、instruct、textgen 走高级 JSON 编辑全部字段。
- **正则脚本** — ST regex 扩展形态导入，全局 + 卡级合并，`USER_INPUT/AI_OUTPUT/WORLD_INFO/REASONING` placement、`minDepth/maxDepth`、`substituteRegex`、`trimStrings`。
- **STscript** — 管道、变量（聊天局部 + 全局）、`/if` 条件、随机/掷骰与聊天动作（`/send`、`/trigger`、`/regenerate`、`/cut`），composer `/` 前缀触发。
- **Prompt Template（EJS）** — `node:vm` 沙箱执行 `<% %>`；`getvar/setvar` 族作用域变量、`[GENERATE:*]`/`[RENDER:*]` 注入、`@INJECT` 整消息插队、`getwi/getchar/getpreset` 资产读取。详见 [`docs/proposals/0008-prompt-template.md`](docs/proposals/0008-prompt-template.md)。
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

- **Agent 游戏桥** — 标准游戏引擎契约（`game.json` 清单 + 零依赖纯函数 `engine.mjs` + 自包含 `view.html`），三源注册（内置 / 导入 / Mod）。棋盘自动显示在与 MVU 状态同位处；Agent 在自己回合内用阻塞等待挂起，人类落子跨 bundle 写穿唤醒，**用户无需发送聊天消息触发下一步**。详见 [`docs/proposals/0018-agent-game-bridge.md`](docs/proposals/0018-agent-game-bridge.md)。
- **九款内置游戏** — 井字棋、五子棋、中国象棋、军棋、21 点、记忆翻牌对战、大富翁、地牢爬行、中国跳棋，开箱可玩。
- **游戏工具 7 件** — `game_list` / `game_start` / `game_state` / `game_history` / `game_move` / `game_wait` / `game_wait_full`，按 token 经济设计：读归读、写归写，wait/move 只回增量。
- **Mod 扩展接口** — 把带 `mod.json` 的目录放进 `$DSH_HOME/tavern/mods/`（或面板内 git 一键安装）即可被识别，默认禁用。首启弹确认层如实展示声明的能力面（知情同意，含无沙箱告知）。启用后可注册：五相位生成 hook（user-input / pre-assemble / pre-llm / post-output / post-save，顺序 waterfall，抛错/超时/忘 return 统一降级不中断生成）、Agent 工具（强制 `<modId>_` 前缀，与内置工具三层查重，冲突即拒）、宿主宏与 STscript 命令、prompt 分区（order 钳制 -50..0）、配额存储（单值 256KB / 总量 1MB）、HTTP 子路由、沙箱化面板 UI（`sandbox="allow-scripts"`，无 same-origin，CSP `connect-src 'none'`）。坏 Mod 只记审计跳过、不拖垮本体；禁用/卸载全注册面回收，全部装载与调用行为落审计日志；`DSH_SOULMOJITO_DISABLE_MODS` 可硬关整个 Mod 系统。Mod 还可声明按钮（manifest `buttons` → 面板与 ST 聊天视图渲染 chip，点击分发到 `api.onButton`）、接收本客户端写入的下行事件推送（聊天保存/资产保存/guides/按钮点击），Mod UI 的 console 输出自动回投宿主的 per-mod 日志查看器。开发者文档见 [`docs/mods/mod-api.md`](docs/mods/mod-api.md)，官方示例覆盖 v1 全部能力面。
- **示例 Mod** — 四个官方示例覆盖 v1 全部能力面：[`asset-stats`](packages/plugin/examples/mods/dsh-soulmojito.asset-stats)（资产只读统计）、[`mood-tracker`](packages/plugin/examples/mods/dsh-soulmojito.mood-tracker)（post-output hook + 情绪工具对 + iframe 面板）、[`story-clock`](packages/plugin/examples/mods/dsh-soulmojito.story-clock)（聊天变量 `clock` + `{{clock}}` 宏 + `/clock` 命令族 + `llm` 门控摘要）、[`rps`](packages/plugin/examples/mods/dsh-soulmojito.rps)。

### Tavern 管理面板

两栏布局（左侧导航 + 右侧内容），窄屏折叠为横向滚动栏；导航品牌块常驻不滚，分区清单独占滚动。18 个分区：

| 分区 | 内容 |
|---|---|
| 总览 | 当前角色 / 预设 / 人设 / 世界书开关与各类资产数量 |
| 角色卡 / 世界书 / 预设 | 导入（PNG / CHARX / JSON）、编辑、搜索、设为当前、导出、删除；保存经服务端格式校验后写回 `$DSH_HOME/tavern/` |
| 聊天 / 群组 / 人设 / 持续指引 / 正则 / 变量 | 各资产的管理面，从设置页统一归位到这里 |
| 小说 / 剧本 | AgentNovel 小说库；剧本资产的分块、绑定与进度 |
| 工作台 | 方案确认入口（逐字段 diff → 批准并应用 / 拒绝）与试写 |
| 游戏 / Mod | 游戏清单与对局面；Mod 清单、能力声明 Pill、两层开关、git 安装与审计计数 |
| 记忆检索 | embed 来源三态（关闭 / 远程 / 本地）与探针 |
| 提示词 | 实发请求 + 世界书激活轨迹的只读查看器 |
| 关于 | 版本 stamp 与官网 / 源码外链 |

编辑器显示未保存状态，取消离开时提示确认，页面关闭提供浏览器级离开保护。

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

- **每聊天一个正式会话** — 每个 Tavern 聊天绑定一个正式 DSH session；view/composer/标题栏只接管带有效 Tavern marker 的会话，普通 DSH 会话保持原生表面。生成循环把 turn/step、流式 chunk、assistant message 与 provider usage 镜像进同一 session，因此标题栏直接复用宿主的 `sessionStats` / `tokenUsage` projection。
- **Composer 模型选择** — 复刻 DSH 原生 model seat 的 provider 分组目录与 Effort 二级菜单，按 session 持久化，未选择时回落 DSH 默认模型。
- **内部工作区** — ST 与 AgentTavern 新聊天共用 `$DSH_HOME/tavern/workspace/` 下的 `Tavern (internal)` 工作区，插件按 workspace 路径/ID 从原生侧边栏隐藏该分组。宿主 `rc.6` 没有可追加到原生 session tree 的正式 list slot，侧栏因此使用一个集中、版本敏感但**失败关闭**的 DOM adapter（只匹配可见左侧 `[role="tree"]`，解绑或卸载时可逆恢复）；面板入口本身走官方 slot，不依赖 adapter 是否挂载成功。
- **语言** — 插件 UI 跟随 DSH 的语言设置（zh/en），切换后无需刷新即时生效。
- **设置页开关** — 「新聊天架构」、「AgentTavern 上下文」、「压缩总结模型」；`worldFollowsCharacter`（世界书跟随角色卡激活）、`preloadAssets`（新 AgentTavern 会话开始时一次性预载角色信息与常驻世界书条目，默认关闭且不追溯已有会话）、`allowGlobalWrites`（允许工具写 global 作用域，默认关闭）、`gamesDisableResign`（禁用投降），以及 `nativePersona`（在标准 DSH Agent 会话中使用当前角色，默认关闭）。设置页标题下显示当前构建的版本与 commit。

### 美化前端（消息内 HTML/JS）

把完整 HTML 文档、`<head>`/`<body>` 片段放进助手消息，或使用 `html` Markdown 代码块，消息保存后会在隔离 iframe 中运行；流式生成与编辑时仍显示源码，避免半成品脚本被重复执行。

- 完整文档：`<!doctype html>...`，或同时包含 `<html>` 与 `<head>`/`<body>`。
- HTML 片段：包含 `<head>` 或 `<body>`；缺外壳时运行时自动补齐 `doctype`、viewport 与基础样式。
- Markdown 代码块：语言标记写 `html`。

每个前端使用 `sandbox="allow-scripts"` 且**不授予 `allow-same-origin`**：脚本不能读写宿主 DOM、Cookie、`window.parent`、`TavernHelper` 或 DSH API（高度回传仅走受校验的 `postMessage`）。CSP 允许内联 CSS/JavaScript 与这些静态源：`cdn.jsdelivr.net`、`testingcf.jsdelivr.net`、`cdn.tailwindcss.com`、`cdnjs.cloudflare.com`、`unpkg.com`、`esm.sh`、`fonts.googleapis.com`、`fonts.gstatic.com`；图片、字体与媒体可用 `https:`、`data:` 或 `blob:`。**不支持**：`fetch`/XHR/WebSocket（`connect-src 'none'`）、嵌套 iframe、`object`/插件、表单提交。高度由 `ResizeObserver` 回传并限制在 80-1200px；TUI/headless 显示原始消息文本，不执行脚本。

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

### 内置自更新

插件自带从 GitHub 发现新版本与一键更新，桌面版不必手敲 `dsh plugin`。

- **发现** — 「设置 → DSH-SoulMojito」标题下与管理面板「总览」显示当前构建、GitHub 最新构建、待合入的 commit 列表与上次检查时间。启动后延迟 12s 首查、每 6h 复查，结果缓存在 `$DSH_HOME/tavern/update-state.json`；「检查更新」按钮穿透缓存立即查。
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
- 数据目录（`$DSH_HOME/tavern/`）与既有资产零迁移；旧写入标记（`dsh-tavern` / `plugin:dsh-tavern`）、旧环境变量（`DSH_TAVERN_*`）、旧游戏命名空间 id（`dsh-tavern.*`）与新名双认——老会话、老对局、老配置行为不断。
- 新写入与新文档一律用新名；旧名只作读取兼容存在。完整映射见 [`decisions/2026-10-16-project-rename-dsh-soulmojito.md`](decisions/2026-10-16-project-rename-dsh-soulmojito.md)。

## 架构与代码结构

### 包结构

| Package | 说明 |
|---|---|
| `@dsh-soulmojito/format` | 卡、PNG/CHARX、世界书、preset、群组文件、regex 脚本与 chat JSONL 的解析与无损往返 |
| `@dsh-soulmojito/lore` | World Info 激活与 timed effects 引擎 |
| `@dsh-soulmojito/macros` | 角色、时间、随机、变量等宏引擎 |
| `@dsh-soulmojito/pipeline` | preset 顺序、lore、persona、历史与 token budget 的 prompt 装配（chat completion + 群聊回合） |
| `@dsh-soulmojito/script` | ST regex 脚本执行器与 STscript 解释器 |
| `@dsh-soulmojito/store` | `$DSH_HOME/tavern/` 原子文件存储、revision 与 session binding |
| `@dsh-soulmojito/template` | EJS Prompt Template 引擎：`node:vm` 沙箱执行、作用域变量与内容注入 |
| `@dsh-soulmojito/bind` | 跨 DSH 版本的宿主形状兼容层：会话事件探测、宿主包锚解析、client 连接双面回退与宿主形状诊断 |
| `dsh-soulmojito` | 插件本体（Node half + Web client half + 随附示例 Mod 与游戏） |

### 构建产物

Node half 是五个自包含 bundle：`index.mjs` 主入口，加 `agent` / `compaction` / `novel` / `card-workbench` 四个子代理入口（见 `packages/plugin/package.json` 的 `exports`）。所有 `@dsh-soulmojito/*` 工作区库全部内联，**无运行时依赖**，不需要用户额外安装公共 `@deepseek-ai/*` 运行时依赖；client closure 由 DSH profile 注入。

这些产物**有意入库**：仓库不发 release/tag，git spec 安装与自更新 checkout 兜底都以分支头为发布通道，产物不入库即装完即坏。唯一例外是 `version.json`（带本地 commit 戳，每次构建不同，不入库）。

### 适配新宿主版本时

跨版本兼容层集中在 `packages/bind`，更新版本适配**先改这里**。client half 的源文件是 `packages/plugin/client/main.js`；`client/index.js` 是 `build:plugin` 的拼接产物（把 bind 的 client 探测模块注入 `__DSH_BIND_CLIENT_SLOT__` 标记处），不要手改，改了会被下次构建覆盖。

插件激活时输出一行 `dsh-soulmojito host shape: {...}` 日志，报告命中的宿主形状绑定路径——排查宿主版本差异从它读起。

## 测试与质量基线

```sh
pnpm run check
```

当前基线（2026-10-17 实测）：

```
Test Files  107 passed (107)
Tests       1789 passed | 1 skipped (1790)
15 gates    全部 PASS
built       v0.6.6 (1d95bde)
```

- 1 项跳过是 `skipIf` 环境条件项：Windows 检出上的 `host-package.spec.ts` POSIX-only 用例。
- 15 个 gates 覆盖 update-routes、package-contract、patch-reference、server-bundle、client-bundle、frontend-runtime、native-header-adapter、mvu-surface、client-architecture-split、internal-workspace、agent-tavern-isolation、client-vm-mount、node-half-mount、v4-session-admission 与 mod-loader。
- 完整 `pnpm run check` 需要可解析 DSH 官方运行时；本仓库验证使用隔离 runtime（`.npm-cache/dsh-runtime`，受限环境依次回落 `NODE_PATH` 与全局安装）。
- 会话事件写入的宿主契约（V4 关系准入、assistant 结算 `usage`/`stream`）由 `packages/plugin/tests/agent-tavern-session-admission.spec.ts` 直接对真实宿主代码回归。
- 示例 Mod 的 engines 与随仓库发布的宿主版本由防漂移守卫锁定（先例：[`decisions/2026-10-12-story-clock-engines-drift.md`](decisions/2026-10-12-story-clock-engines-drift.md)）；面板布局、品牌 logo 与内置游戏规则面同样各有 spec + gate marker 锁定。

GUI 已在桌面与 390x844 移动视口验证，覆盖原生 sidebar、管理面板、资产编辑器、conversation view/composer、流式生成、Stop、edit、swipe、regenerate、rename/delete 与 revision 冲突。

## 文档

项目文档按四类分放，**完整索引见 [`docs/README.md`](docs/README.md)**：

| 目录 | 内容 |
|---|---|
| [`docs/proposals/`](docs/proposals/) | 18 篇架构级设计契约（提案 0001-0018），实现后在此登记 |
| [`decisions/`](decisions/) | 88 篇单次落地决策：问题、方案、否决项、与规格的偏差 |
| [`docs/exploration/`](docs/exploration/) | 调研归档，结论必须带证据坐标（文件:行号） |
| [`docs/plans/`](docs/plans/) · [`docs/adr/`](docs/adr/) · [`docs/mods/`](docs/mods/) | 施工计划 · 架构决策记录 · Mod 开发者文档 |

从这几篇读起：

- [`docs/proposals/0001-tavern-architecture.md`](docs/proposals/0001-tavern-architecture.md) — 当前架构、边界与后备路线。
- [`docs/proposals/0004-agent-tavern-architecture.md`](docs/proposals/0004-agent-tavern-architecture.md) — AgentTavern 原生 AgentLoop 架构、记忆/变量工具、遗忘策略。
- [`docs/proposals/0018-agent-game-bridge.md`](docs/proposals/0018-agent-game-bridge.md) — 游戏桥标准与权威状态论证。
- [`CONTEXT.md`](CONTEXT.md) — 项目架构语言的统一词表（AgentTavern / ST 架构 / 上下文 / 记忆 / 遗忘 / 作用域），动手前先读。
- [`docs/exploration/2026-10-11-jsr-lwb-reference.md`](docs/exploration/2026-10-11-jsr-lwb-reference.md) — 竞品参考与不复刻清单。

## 许可

GPL-3.0。项目只实现公开规范和可观察行为语义，不复制 SillyTavern 的 AGPL 源码。Fabric 与 dsh-ads 仅用于架构调研，第一版运行时不依赖它们。
