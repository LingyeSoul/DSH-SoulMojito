# dsh-tavern 插件包

该目录是可安装的 DSH 官方 Web bundle。仓库根的 `pnpm run build:plugin` 会把五个 workspace 纯库和 Node half 打入单一 `index.mjs`。client closure 由 DSH profile 注入，不要求用户另行安装公共 `@deepseek-ai/*` 依赖。

## 安装

```sh
pnpm run build:plugin
dsh plugin --profile web add ./packages/plugin
dsh --profile web
```

安装后：

- 在“设置 -> dsh-tavern”导入角色卡、世界书和 Chat Completion preset，并选择 persona 或行为开关。
- 在 DSH 原生侧边栏的 Tavern 分支创建或打开角色聊天。
- 在原生 `Tavern` tab 使用 transcript、composer、Stop、edit、swipe 和 regenerate。

聊天文件保存在 `$DSH_HOME/tavern/chats/`，并使用 revision compare-and-swap 防止跨标签页静默覆盖。

## 验证

```sh
pnpm run build:plugin
node packages/plugin/scripts/gates/run.mjs
```

当前 gate 覆盖包元数据、Cordis patch、Node/client bundle、client VM mount、Node half mount，以及原生 slot、revision、stale binding 和设置页边界。
