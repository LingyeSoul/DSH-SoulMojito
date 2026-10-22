# 项目改名：dsh-tavern → DSH-SoulMojito（2026-10-16）

需求源：2026-10-16 用户「我想重命名项目为 DSH-SoulMojito」。四问对齐定案：**全改名 + 旧数据兼容读**（存量会话/对局/env 配置行为不断）、**GitHub 仓库同步改名**（旧 URL 由 GitHub 自动重定向）、**历史归档保原文**（decisions/plans/exploration 不改写）、**本地工作目录用户手动改**（不在本决策落地）。

## 命名映射（唯一事实来源）

| 面 | 旧 | 新 |
|---|---|---|
| 显示名 | dsh-tavern | **DSH-SoulMojito** |
| 包/仓库 slug | dsh-tavern | **dsh-soulmojito**（GitHub 仓库 `LingyeSoul/DSH-SoulMojito`） |
| 根包 / 插件包名 | `dsh-tavern` | `dsh-soulmojito` |
| 工作区 scope（8 包） | `@dsh-tavern/{bind,format,lore,macros,pipeline,script,store,template}` | `@dsh-soulmojito/*` |
| 模块 specifier | `dsh-tavern/{agent,novel,compaction,card-workbench}` | `dsh-soulmojito/*`（cordis.patch.yml 与 exports 联动） |
| 插件挂载名 / cordis id | `dsh-tavern` | `dsh-soulmojito` |
| HTTP API 前缀 | `/api/dsh-tavern` | `/api/dsh-soulmojito` |
| 全局 key / 事件词汇 | `dsh-tavern:*`、`__DSH_TAVERN_BIND__`、`__dshTavernNovelBootId` | `dsh-soulmojito:*`、`__DSH_SOULMOJITO_BIND__`、`__dshSoulMojitoNovelBootId` |
| 内置游戏 id（7 款） | `dsh-tavern.<game>` | `dsh-soulmojito.<game>` |
| 示例 Mod/游戏命名空间 | `dsh-tavern.{story-clock,mood-tracker,asset-stats,rps,gomoku}` | `dsh-soulmojito.*`（目录 git mv + mod.json/engine/game.json/视图内容） |
| 环境变量族 | `DSH_TAVERN_*` | `DSH_SOULMOJITO_*` |
| 自更新仓库 | `LingyeSoul/dsh-tavern` | `LingyeSoul/DSH-SoulMojito`（`UPDATE_REPOSITORY`、user-agent、README 安装命令） |

**刻意不改**（非项目标识，改之即伤）：`Tavern` 架构术语（AgentTavern / 酒馆面板 / `preset-agent-tavern` 等 config id）、数据目录 `$DSH_HOME/tavern/`（store/mods/games/update-state 全在其下）、会话路径编码 `--root-.dsh-tavern-workspace--`（`$DSH_HOME/tavern/workspace` 的宿主编码——见「误伤与修复」2）。

## 兼容层（写新、读双；旧名只作读取通道存在）

1. **持久化 source 标记**（`packages/bind/src/host-session.ts`，改名兼容的读侧唯一中枢）：新增 `PLUGIN_NAME` / `LEGACY_PLUGIN_NAME`（`'dsh-soulmojito'` / `'dsh-tavern'`）与 `TAVERN_PLUGIN_SOURCE_KIND` / `LEGACY_TAVERN_PLUGIN_SOURCE_KIND`。`hostPluginMessageSource` 写新名（v4 kind `plugin:dsh-soulmojito`；v0-3 `{kind:'plugin', plugin:'dsh-soulmojito'}`）；`isHostPluginMessageSource` 双认四种旧形态（新旧 kind × 新旧 plugin 成员）。存量会话的激活/关闭/预设 marker 据此继续可认。
2. **镜像 provider 戳**（`agent-tavern/projector.ts`）：`isTavernSessionMarker` 对 model 镜像的合成 provider 双认（旧 `dsh-tavern`/`agent-tavern-import`）；新写入恒 `dsh-soulmojito`。
3. **环境变量**（新文件 `src/env-compat.ts`，7 个读取点接线：index ×3、mods/host ×1、update/sources ×2、update/apply ×1）：`envCompat(suffix)` 新前缀优先、旧前缀兜底；构建脚本 `DSH_SOULMOJITO_COMMIT` 后补 `DSH_TAVERN_COMMIT`。
4. **游戏 id 别名**（`src/games/registry.ts` `get()` 单点）：`dsh-tavern.<name>` 直接落空时映射到 `dsh-soulmojito.<name>`——存量对局文件（`gameId` 持久化字段）不被判孤儿；**直接命中永远优先**（用户装过的旧名导入目录按自身解析，别名不遮蔽在册条目）。
5. **engines 旧键**（`games/standard.ts` + `mods/manifest.ts` 双读，新键优先）：旧键 `engines['dsh-tavern']` 与 `engines.dsh-tavern` 的存量示例/三方包/已装 Mod 不改也能装载；校验循环两键同名报错。
6. **客户端 source 双读**（`client/main.js` `isTavernSource`）：`plugin:dsh-tavern`、`{kind:'plugin', plugin:'dsh-tavern'}` 与新旧名同认（存量会话的 composer 接管/关闭判据）。
7. **修复工具双读**（`scripts/lib/session-turn-repair.mjs`、`repair-session-sources.mjs`、`repair-v4-sessions.mjs`、`repair-tavern-mirror-source.mjs`）：v0/v4 工件由改名前的插件写入，凡按 source 身份筛选处双认；`repairSourceKind` 按原 `plugin` 值派生 kind（`plugin:<name>`，新旧各自保留身份）。

## 执行与证据

- 机械层：一次性 token 替换（脚本 + 逐文件计数）**171 个入库文件、1550 处**（排除归档/构建产物/node_modules；`scripts/lib/` 因排除规则误漏，手工补处理）。token 序：仓库 slug → `dsh-tavern` → `DSH_TAVERN` → `dshTavern` → `dsh_tavern`。
- workspace 重链接：10 个 package.json 改名/改依赖后 `pnpm install`（lockfile 旧名 0 命中、新名 4；`@dsh-soulmojito/*` 符号链接建立）。
- examples：5 个目录 `git mv`（4 mod + 1 游戏）＋内容替换。
- gates 新增改名兼容证据块（`server-bundle`：旧持久化名 / 旧 env 前缀 / 旧游戏命名空间前缀三 marker；`client-bundle`：旧 producer kind marker）＋ 逐条负样本自证（替换值均不含原 marker 子串）。
- 测试：全仓引用随机械层更新；新增 `env-compat.spec.ts`（4 项：新优先/旧独存仍读/缺省 undefined/空串不回退）、bind 改名兼容 describe（3 项：读侧双认/写侧恒新名/陌生名不误收）、registry 别名（2 项：别名解析 + 存量对局文件不被判孤儿）、engines 旧键（mods 清单 + games 导入各 1）、投影 marker 双认断言。
- 文档：根 README（标题改显示名 + 「从旧名迁移」段 + 开关注记 + 决策链接）、插件 README（标题/设置路径/迁移注记）、CONTEXT.md、docs/mods/mod-api.md（engines 旧键注记）、docs/proposals 全量随机械层、设置页标题显示名（client `h2`）。

## 验证（本机 Windows，2026-10-16）

- `tsc -b`：零错。`node scripts/build-plugin.mjs`：五个 bundle + client/index.js + version.json 重建（v0.6.5 bb94491 前一刻的 HEAD 戳）。
- **15 个 gates 全 PASS**（含三新 server marker 与一新 client marker 的负样本自证）。
- 全量 `pnpm vitest run --hookTimeout=120000`：**104 文件、1690 过、0 挂**（1 个 `skipIf(process.platform === 'win32')` 平台条件跳过——`host-package.spec.ts` POSIX-only 用例，与改名无关；作者环境基线 0 跳过）。README 基线已同步回填。
- 残留审计：`dsh-tavern` 在非归档区仅存于 23 个文件的**制裁位置**——7 个兼容实现文件（bind/projector/registry/standard/manifest/env-compat/client）、4 个修复/重放工具、5 个兼容测试、gates、2 份 README/mods 文档注记、2 处工作区编码 fixture。归档（decisions 123 处 + plans + exploration）保原文属预期。

## 误伤与修复（蓝军自攻击留档）

1. **`.dsh-tavern-workspace` 是编码不是名字**：它是宿主对工作区路径 `$DSH_HOME/tavern/workspace`（fixture 形态 `/root/.dsh/tavern/workspace`）的会话目录编码（`dsh/tavern` → `dsh-tavern`；`--root-…--` 包裹）。机械层把它当品牌串替换 10 处（`repair-v4-sessions.spec.ts` ×6、`repro-new-chat.mjs` ×4），夹具目录名与 `header.cwd` 的编码不再对应，全量测试以 4 红（修复脚本对健康工件报 DIRTY-BUT-UNRECOGNIZED）精准抓出，已全部回滚。教训：**替换前先问「这个字符串是名字，还是别的名字的派生值」**——同形不同源，机械替换必须有一轮测试闭环兜底，本轮闭环工作正常。
2. **CRLF 检出下的多行锚失配**（既有问题，本次发现）：`core.autocrlf=true` 的 Windows 工作区里示例 `engine.mjs` 为 CRLF，而 `games-import.spec.ts` 的 `boom.engine` 负样本用 LF 多行锚对源码做替换——锚失配 → 补丁静默不打 → 引擎成功装载并以 meta id 遮蔽内置，用例翻红。与改名无关但在本轮暴露；修复为夹具读取处行尾归一（`.replaceAll('\r\n', '\n')`），LF/CRLF 两种检出世界输出一致。
3. **检索语料 SEED 更名 = 有意识重基线**：`dsh-soulmojito-retrieval-eval-v1` 使 record revision 派生变化 → `CORPUS_HASH` 从 `3419b1ba…` 更新为 `c9399a9c…`（内容/维度/期望零改动；矩阵 5 项复跑全绿确认指标基线不受影响）。

## 边界与交接

- 本地目录 `<local checkout>\dsh-tavern` 不改名（用户手动；IDE/宿主锁与当前会话 cwd 均在占用）。GitHub 仓库改名由用户执行（GitHub 自动重定向旧 URL；改名前本仓库代码已指向新 slug，改名前后自更新链路都成立——改名后新 slug 解析，改名前旧 slug 由重定向兜底）。
- 存量安装迁移 = 一次 `remove dsh-tavern` + 重装（见 README「从旧名迁移」）；数据零迁移。
- 宿主侧对 v4 producer-owned kind（`plugin:dsh-tavern`）在旧会话工件里的校验**不在插件控制面**（预期按不透明字符串处理，与宿主迁移产物同款），如实标注为外部依赖；如未来宿主收紧生产者名单校验，退化面是旧会话 marker 识别，兜底通道为插件侧读双认不变。
- 版本 0.6.5 不升版：改名非特性增量，分支头即发布通道；`dist` 随 `pnpm check` 重建入库。
