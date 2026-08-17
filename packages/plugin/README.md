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
- “设置 -> dsh-tavern”保留快速切换（角色/预设/persona/世界书）与「打开酒馆面板」入口；设置页标题下显示插件版本号与 commit 号。构建会生成不纳入 Git 的 `version.json` 旁车文件；源码检出运行时优先读取 Git HEAD，脱离 `.git` 的发布包读取该文件中的 commit，必要时可用 `DSH_TAVERN_COMMIT` 兜底。
- 在原生 `Tavern` tab 使用 transcript、composer、Stop、edit、swipe 和 regenerate。
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

## 语言

插件 UI 跟随 DSH 的语言设置（`@deepseek-ai/dsh-client-locale`，zh/en）：client half 声明 `inject: [..., 'locale']`，向 locale 服务注册 `dsh-tavern` 命名空间字典并经 `useSyncExternalStore` 订阅快照，在“通用设置 -> 语言”切换后无需刷新即时生效。字典 zh/en 键集与 `{param}` 占位符的对称性由 `client-vm-mount` gate 校验。

## 验证

```sh
pnpm run build:plugin
node packages/plugin/scripts/gates/run.mjs
```

当前 gate 覆盖包元数据、Cordis patch、Node/client bundle、frontend runtime、client VM mount、Node half mount，以及原生 slot、revision、stale binding 和设置页边界。
