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
- “设置 -> dsh-tavern”保留快速切换（角色/预设/persona/世界书）与「打开酒馆面板」入口；设置页标题下显示插件版本号与构建 commit 号（构建时由 `scripts/build-plugin.mjs` 注入 bootstrap）。
- 在原生 `Tavern` tab 使用 transcript、composer、Stop、edit、swipe 和 regenerate。

聊天文件保存在 `$DSH_HOME/tavern/chats/`，并使用 revision compare-and-swap 防止跨标签页静默覆盖。删除角色会连同其聊天记录一并移除（对齐 ST 语义），并自动收敛群组成员与失效会话绑定。

## 语言

插件 UI 跟随 DSH 的语言设置（`@deepseek-ai/dsh-client-locale`，zh/en）：client half 声明 `inject: [..., 'locale']`，向 locale 服务注册 `dsh-tavern` 命名空间字典并经 `useSyncExternalStore` 订阅快照，在“通用设置 -> 语言”切换后无需刷新即时生效。字典 zh/en 键集与 `{param}` 占位符的对称性由 `client-vm-mount` gate 校验。

## 验证

```sh
pnpm run build:plugin
node packages/plugin/scripts/gates/run.mjs
```

当前 gate 覆盖包元数据、Cordis patch、Node/client bundle、client VM mount、Node half mount，以及原生 slot、revision、stale binding 和设置页边界。
