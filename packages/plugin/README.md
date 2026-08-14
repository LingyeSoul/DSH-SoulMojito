# dsh-tavern 插件包

该目录是可安装的 DSH 官方 Web bundle。仓库根的 `pnpm run build:plugin` 会把五个 workspace 纯库和 Node half 打入单一 `index.mjs`。client closure 由 DSH profile 注入，不要求用户另行安装公共 `@deepseek-ai/*` 依赖。

## 安装

```sh
pnpm run build:plugin
dsh plugin --profile web add ./packages/plugin
dsh --profile web
```

安装后：

- 在“设置 -> dsh-tavern”导入角色卡、世界书和 Chat Completion preset，并选择 persona 或行为开关；设置页标题下显示插件版本号与构建 commit 号（构建时由 `scripts/build-plugin.mjs` 注入 bootstrap）。
- 在 DSH 原生侧边栏的 Tavern 分支创建或打开角色聊天。
- 在原生 `Tavern` tab 使用 transcript、composer、Stop、edit、swipe 和 regenerate。

聊天文件保存在 `$DSH_HOME/tavern/chats/`，并使用 revision compare-and-swap 防止跨标签页静默覆盖。

## 语言

插件 UI 跟随 DSH 的语言设置（`@deepseek-ai/dsh-client-locale`，zh/en）：client half 声明 `inject: [..., 'locale']`，向 locale 服务注册 `dsh-tavern` 命名空间字典并经 `useSyncExternalStore` 订阅快照，在“通用设置 -> 语言”切换后无需刷新即时生效。字典 zh/en 键集与 `{param}` 占位符的对称性由 `client-vm-mount` gate 校验。

## 验证

```sh
pnpm run build:plugin
node packages/plugin/scripts/gates/run.mjs
```

当前 gate 覆盖包元数据、Cordis patch、Node/client bundle、client VM mount、Node half mount，以及原生 slot、revision、stale binding 和设置页边界。
