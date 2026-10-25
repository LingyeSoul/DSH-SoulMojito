# 内置自更新：从 GitHub 发现新版本 + 一键更新（桌面版适配）

日期：2026-10-05

## 背景

桌面版（`<DSH_INSTALL>`，DSH `0.2.0-rc.2` 运行时）的 profile 用 git spec 安装本插件：

```jsonc
// %USERPROFILE%\.dsh\profiles\desktop\package.json
"dependencies": { "dsh-tavern": "git+https://github.com/LingyeSoul/dsh-tavern.git" },
// pnpm-lock.yaml 把 spec 解析成 <commit>&path:/packages/plugin
```

三个现场问题：

1. **装了什么版本看不出来。** `version.json` 被 `.gitignore` 排除，git 安装现场既没有 `.git` 也没有旁车文件，`readBuildInfo()` 只能读 `package.json` 的版本号，commit 是 `unknown`（实测桌面版 bootstrap 返回 `commit: "unknown"`）。
2. **没有升级入口。** 仓库不发 release、不打 tag（`releases.atom`/`tags.atom` 都是空 feed），宿主 `@deepseek-ai/dsh-plugin-manager` 也没有 update/upgrade 方法，桌面版文档明确说「升级 = 卸载后重装」。用户只能手敲 `dsh plugin --profile desktop add <spec>`。
3. **升级后要重启。** 包替换必须换新的 JS module generation，宿主 HMR 默认 `ignored: ["**/node_modules", ...]`，装在 `node_modules/dsh-tavern` 的插件不会被文件监听重载。

## 决策

### 1. 「新版本」= main 分支最新 commit + `packages/plugin/package.json` 的 version

仓库没有 release/tag，插件产物（`index.mjs` 等）是**提交进仓库的构建产物**，因此分支头就是发布通道。判定规则（`src/update/github.ts` 的 `compareBuilds`）：

1. commit 相同 → `up-to-date`；
2. 远端版本更高 → `update-available`；更低 → `local-ahead`（源码检出比远端新，不提示）；
3. 版本相同但 commit 不同：
   - 改动清单可信（api 的 compare）且不含 `packages/plugin/` → `up-to-date`，不让文档提交把用户拖进一次 pnpm 安装；
   - 改动清单不可信 → `update-available`。这个仓库不随每次提交 bump 版本，把「读不到改动」当成「没有改动」会让被限流/被墙的用户永远收不到新版本；
4. 版本号读不到（例如只剩 `git ls-remote`）时同样退到 commit 判定；
5. 两边都比不了 → `unknown`，不谎报「已是最新」。

### 2. 三个来源降级 + curl 兜底

`api`（api.github.com commits/compare + contents 读 package.json，raw 兜底）→ `raw-git`（raw package.json + `git ls-remote`）→ `atom`（commits atom feed）。

**本机实测的重要事实：node 的 `fetch` 到 GitHub 全部失败**（`unable to verify the first certificate` —— 企业 TLS 中间人的根证书在 Windows 证书库里，不在 node 的 CA bundle 里），而 `curl.exe`（Schannel，走系统证书库）与 `git` 都正常。因此每个 HTTP 请求都是 `fetch → curl` 两级：fetch 失败后用 `curl --fail --location --max-time` 重试。没有这层兜底，`api`/`raw`/`atom` 全部不可用，只剩 commit 判定（`source: raw-git`）。

`curl` 兜底开销是每个请求一个子进程（一次检查最多 3 个），`DSH_TAVERN_DISABLE_CURL=1` 可关闭，`DSH_TAVERN_CURL` 可指定路径；`GITHUB_TOKEN`/`GH_TOKEN` 存在时只给 `api.github.com` 的 fetch 加 `authorization`（curl 分支不带，避免把 token 暴露在命令行）。**不能发给 raw.githubusercontent.com：它收到带认证的请求会回 404**，版本号会因此变成 `unknown`（面板显示「GitHub v?」）。5xx/429/连接抖动重试一次，避免一次瞬时 502 被缓存成 6h 的「版本未知」。

### 3. 落地顺序：CLI → plugin-manager → checkout

**为什么 CLI 优先（本机实测 + 代码证据）**：宿主 `PluginManager.installBundle(spec)` 装完靠「manifest 前后 diff」定位目标包（`lib/index.js`：`installed = keys.filter(name => before[name] !== after[name])`，为空时再按 `spec === name || spec.startsWith(name + '@')` 兜底）。而 **pnpm 对 git 依赖永远把 manifest 值写成裸仓库 URL**，commit 只记在 lockfile：

```sh
# 实测：github:LingyeSoul/dsh-tavern#<sha>&path:/packages/plugin
# package.json 里仍是 "git+https://github.com/LingyeSoul/dsh-tavern.git"
# 只有 pnpm-lock.yaml 的 version 行从 992d321… 变成 8271f20…
```

所以对已安装的 git 依赖，`installBundle` 的 diff 恒为空、spec 也不匹配 `name`/`name@`，会抛 `ambiguous-install` 并回滚。`dsh plugin --profile <p> add <spec>` 直接跑 pnpm add（`operations.js` 的 `runPluginCommand`，无目标包推断），是唯一能把 lockfile 原地指到新 commit 的路径。

三条路径：

1. **`cli`** —— 桌面版自带 `dsh plugin`。宿主进程 `argv[2]` 是 runtime 目录（`<app.asar>/dsh`，见 `dsh-desktop-host` 的 `main()`），该目录下存在 `@deepseek-ai/dsh-desktop-host/lib/cli.js` 时，用 `DeepSeek Harness.exe --expose-internals <cli.js> plugin --profile desktop add <spec>` 复刻 `resources\runtime\cli\bin\dsh.cmd`（`DSH_TAVERN_DSH_CLI` 可覆盖）。**直接 spawn exe，不走 `.cmd`**：实测 `.cmd` 会把 spec 里的 `&path:` 吃掉（cmd 把 `&` 当命令分隔符），而直接 spawn 与 pnpm 都保留子目录。
2. **`plugin-manager`** —— `ctx.get('pluginManager')` 或 `ctx.inject` 动态捕获（**不写进 `inject` 静态数组**，否则没有该服务的宿主整插件不挂载）。用于非桌面宿主（例如 web profile 的 `link:` 依赖换成 git 源时 manifest 值确实会变，diff 可用）。npm registry 依赖同样走这条。
3. **`checkout`** —— git clone 到临时目录再把 `packages/plugin` 的发布产物覆盖进安装目录（先删后拷，避免破坏 pnpm store 硬链接）。profile 的 lockfile 仍指向旧 commit，结果文案里明确给出让用户补一条 `dsh plugin … add <spec>` 的命令。

三条都返回 `restart-required`：装完必须重启 DSH。安装成功后状态进入 `restart-required` 过渡态，在本地构建 stamp 追上已安装 commit 之前不再重复提示更新。

### 4. 自动发现 + 进度

- 启动后延迟 12s 首查、之后每 6h 复查（`unref` 定时器，不阻塞进程退出）；TTL 内复用 `$DSH_HOME/tavern/update-state.json` 缓存，`GET update?refresh=1` 与手动检查穿透 TTL。
- 所有网络失败只写进快照的 `error`，绝不影响插件挂载、bootstrap 与页面渲染。
- 安装进度：`plugin-manager/install-log` 的 chunk（按 `requestId` 过滤）与 `install-state` 阶段进环形日志（最近 60 行），客户端按 1.5s 轮询 `GET update` 读阶段与日志尾部；不引入 SSE。

### 5. 构建期 stamp（esbuild define）

`scripts/build-plugin.mjs` 用 `define` 注入 `__TAVERN_VERSION__` / `__TAVERN_COMMIT__`，`readBuildInfo()` 在 `version.json` 缺失时读它们（`typeof` 守卫，vitest 下未定义即回退）。这样 git 安装现场的 commit 不再是 `unknown`，比较才有意义。gate `server-bundle` 断言 bundle 里既没有残留的标识符、也带上了 `package.json` 的版本字面量与构建 commit 字面量。

### 6. 配置与关闭开关

| 开关 | 位置 | 作用 |
|---|---|---|
| `checkForUpdates: false` | profile `cordis.patch.yml` 的 `dsh-tavern` 行 config | 关闭自动发现（路由仍可用） |
| `DSH_TAVERN_DISABLE_UPDATE_CHECK` | 环境变量 | 同上 |
| `DSH_TAVERN_DISABLE_CURL` | 环境变量 | 关闭 curl 兜底（不装 curl 的宿主） |
| `DSH_TAVERN_CURL` | 环境变量 | 指定 curl 路径 |
| `GITHUB_TOKEN` / `GH_TOKEN` | 环境变量 | 给 fetch 分支加限流配额 |

## 备选方案

- **只比版本号**：被否——本仓库 0.3.8 之后有多个只改源码/产物的提交没有 bump 版本，只比版本号会漏掉真实更新。
- **用 GitHub Releases / tag 做发布通道**：被否（现状）——仓库没有 release/tag，改动发布流程超出本插件范围；发现层保留了 release/tag 可用时的落地位置（`remote.ref`）。
- **下载 codeload tarball 落地**：被否——本机 `codeload.github.com` 稳定 502，且 tarball 方案绕不过 cli/plugin-manager 的前两条路径；checkout 兜底改用 `git clone`。
- **`removeBundle` + `installBundle` 组合更新**：被否——会在执行中的请求里卸载插件自身（webServer 路由注销、effect 释放），失败面远大于收益。
- **把 `pluginManager` 写进静态 `inject`**：被否——没有该服务的宿主会让整个插件不挂载；改为可选探测 + 动态注入捕获。
- **客户端 SSE 流式进度**：暂缓——`api()` 是请求/响应单通道，轮询足以覆盖「pnpm 跑 20 秒」的粒度。

## 后果

- 桌面版可以直接在「设置 → dsh-tavern」或管理面板「总览」看到「已安装 v0.3.9 (8271f20) / GitHub v0.3.8 (8271f20)」与「检查更新 / 立即更新」按钮；点更新后提示重启 DeepSeek Harness。
- 更新一次需要重启进程，这是宿主语义不是本插件的选择；插件不静默重启宿主。
- 被墙/被限流环境下仍可用：`git ls-remote` + `curl` 两条腿各自独立。
- gate 新增 `update-routes`（在子进程里以 stub ctx + stub GitHub 跑真实 bundle 的三条路由：check → install（CLI 确定性失败后落到 plugin-manager 替身）→ `restart-required`，并断言 pnpm 日志流入快照），`server-bundle` 增加构建 stamp 断言，`client-vm-mount` 增加自更新接线与 zh/en 更新键集断言。
- 副作用修复：`packages/plugin/tests/agent-novel-projector.spec.ts` 的「projection-pending marker」用例此前依赖「`NovelStore` 的异步投影写入已经落盘」这一隐含前提（§10.2 step 5 的 fire-and-forget），并行负载下会读到后台写入的完整 status 而失败；现在显式等到最终 revision 的写入落盘再植入 marker。这是既存时序竞态，不是本次功能引入的。
