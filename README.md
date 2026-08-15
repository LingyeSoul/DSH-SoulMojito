<h1 align="center">dsh-tavern</h1>

<p align="center">把 DSH（deepseek-harness）扩展成兼容 SillyTavern 生态的原生角色扮演工作区。</p>

## 当前状态

第一版主线已经可用：插件复用 DSH 的 LLM 路由、默认模型、密钥管理、Web 容器和插件安装机制，同时在 DSH 原生侧边栏和 conversation 区域提供 Tavern 角色扮演体验。设置页只负责资产与行为配置，不承载聊天工作台。

当前面向 DSH `0.1.0-rc.6` 验证。Fabric 不在第一版运行路径中。

## 能力

- Character Card V1/V2/V3：JSON、PNG `chara`/`ccv3`，以及 CHARX `card.json` 和 `embeded://` assets。
- World Info / Lorebook：递归扫描、副键逻辑、概率、预算、inclusion group、sticky/cooldown/delay 和位置分发。
- Chat Completion preset：`prompts[]`、`prompt_order[]`、marker 和采样参数。
- SillyTavern chat JSONL：header、messages、`swipes`、`swipe_id`、`swipe_info`。
- RP 交互：流式生成、Stop、消息编辑、swipe、regenerate、聊天创建、重命名和确认删除。
- 消息分支 / bookmark：任意消息一键分支为新聊天，`chat_metadata.bookmark_link` 回链，视图可跳回父聊天。
- Persona 管理：PNG 导入（内嵌描述提取）、头像、增删改、激活选择与 `position/depth/role` 注入。
- 群聊：成员管理、自然（talkativeness 加权）/列表激活策略、成员点触发言、`group_only_greetings`、group nudge 和 `{{group}}` 宏。
- 正则脚本：ST regex 扩展形态导入，全局 + 卡级合并，`USER_INPUT/AI_OUTPUT/WORLD_INFO/REASONING` placement、`minDepth/maxDepth`、`substituteRegex`、`trimStrings`。
- STscript：管道、变量（聊天局部 + 全局）、`/if` 条件、随机/掷骰和聊天动作（`/send`、`/trigger`、`/regenerate`、`/cut`），composer `/` 前缀触发。
- Text Completion / Kobold：context（story_string `{{#if}}` 子集）、instruct、textgen 采样器 preset 装配单串 prompt，KoboldAI/KoboldCpp SSE 流式 + 单发回退，端点/密钥/预设配置与连接测试。
- Composer 模型选择：复刻 DSH 原生 model seat 的 provider 分组目录与 Effort 二级菜单，按 session 持久化，未选择时回落 DSH 默认模型。
- 并发保护：聊天使用内容 revision 做 compare-and-swap；跨标签页冲突返回 `409`，客户端重新加载最新内容，不静默覆盖。
- 可选的普通 Agent 人格注入，默认关闭。

## 原生集成

插件保留独立的 RP prompt/生成循环，但 UI 进入 DSH 原生表面：

| DSH slot | 用途 |
|---|---|
| `conversation.view` | Tavern JSONL transcript |
| `conversation.composer` | Tavern session 的 RP 输入框、模型选择与 Stop |
| `conversation.session.header.actions` | 当前角色与 regenerate |
| `settings.section` | 角色、世界书、preset、persona、导入和行为开关 |
| `shell.overlay` | 侧边栏 adapter 生命周期与折叠后的浮动导航 |
| `sidebar.footer.action` | 原生侧边栏不可挂载时的 Tavern fallback 入口 |

DSH `rc.6` 没有可追加到原生 session tree 的正式 list slot。侧边栏因此使用一个集中、版本敏感但失败关闭的 DOM adapter：只匹配可见左侧 `[role="tree"]`，插入具名 `data-dsh-tavern-sidebar-host`，并在 teardown 时断开 `MutationObserver`、取消 animation frame、删除 host。匹配失败时保留原生 UI，只显示 footer fallback。

每个 Tavern chat 绑定一个正式 DSH session。`/tavern` 内部命令追加 plugin notice marker，使 session 进入 active 状态而不调用模型；composer chain 仅接管带有效 Tavern marker 的 session。删除聊天时会追加 close marker并归档对应 DSH session。

## Packages

| Package | 说明 |
|---|---|
| `@dsh-tavern/format` | 卡、PNG/CHARX、世界书、preset（chat completion / context / instruct / textgen）、群组文件、regex 脚本和 chat JSONL 的解析与无损往返 |
| `@dsh-tavern/lore` | World Info 激活和 timed effects 引擎 |
| `@dsh-tavern/macros` | 角色、时间、随机、变量等宏引擎 |
| `@dsh-tavern/pipeline` | preset 顺序、lore、persona、历史和 token budget 的 prompt 装配（chat completion + text completion + 群聊回合） |
| `@dsh-tavern/script` | ST regex 脚本执行器与 STscript 解释器 |
| `@dsh-tavern/store` | `$DSH_HOME/tavern/` 原子文件存储、revision 和 session binding |
| `dsh-tavern` | 自包含 Node half、Web client half、安装元数据和 gates |

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

### 更新

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

### 验证

```sh
pnpm run check
```

打开 DSH 后：

1. 在“设置 -> dsh-tavern”导入角色卡、世界书和 Chat Completion preset。
2. 在原生左侧 Tavern 分支展开角色并创建或打开聊天。
3. 在原生 `Tavern` tab 中对话、编辑、切换 swipe 或 regenerate。

插件 Node bundle 是单一 `packages/plugin/index.mjs`，五个纯库均已内联。无需用户额外安装公共 `@deepseek-ai/*` 运行时依赖；client closure 由 DSH profile 注入。

## 验证

```sh
pnpm run check
```

当前基线：15 个测试文件、134 项测试通过；package contract、patch reference、server bundle、client bundle、client VM mount 和 Node half mount 六道 gate 全部通过（路由保护覆盖 persona、群组、branch、regex、STscript 与 Kobold 端点）。

GUI 已在桌面和 390x844 移动视口验证，包括原生 sidebar、折叠 fallback、conversation view/composer、设置页、流式生成、Stop、edit、swipe、regenerate、rename/delete 和 revision 冲突。

## 文档

- [`docs/proposals/0001-tavern-architecture.md`](docs/proposals/0001-tavern-architecture.md)：当前架构、边界与后备路线。
- [`docs/proposals/0002-branch-persona-groups-script-textcompletion.md`](docs/proposals/0002-branch-persona-groups-script-textcompletion.md)：branch/bookmark、persona 管理、群聊、STscript/regex 与 Text Completion/Kobold 的范围与格式。
- [`docs/exploration/2026-08-14-fabric-architecture.md`](docs/exploration/2026-08-14-fabric-architecture.md)：Fabric 调研与后备定位。
- [`docs/exploration/2026-08-14-st-formats.md`](docs/exploration/2026-08-14-st-formats.md)：SillyTavern 互操作格式与行为参考。
- [`decisions/2026-08-14-card-raw-passthrough.md`](decisions/2026-08-14-card-raw-passthrough.md)：角色卡未知字段透传决策。
- [`decisions/2026-08-15-v2-feature-scope.md`](decisions/2026-08-15-v2-feature-scope.md)：v2 功能面的范围与形态选择。

## 许可

GPL-3.0。项目只实现公开规范和可观察行为语义，不复制 SillyTavern 的 AGPL 源码。Fabric 与 dsh-ads 仅用于架构调研；第一版运行时不依赖它们。
