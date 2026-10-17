# 面板游戏包导入（zip 上传 + git 安装）与标准游戏包制作指南

> 日期：2026-10-17。需求源：用户实报——管理面板「游戏」页没有上传按钮，文档也没有
> 如何制作符合标准的游戏包。前者是提案 0018 P2「面板导入入口与失败原因展示」的落地
> 欠账（2026-10-13 决策与客户端注释都声称存在，实际只有服务端 `POST games/install`）；
> 后者是文档缺口（只有提案 §3 设计契约与 Mod 单一路径的 mod-api §18，没有面向游戏包
> 作者的操作指南）。设计契约：[提案 0018](../docs/proposals/0018-agent-game-bridge.md)
> §3 / §4.5 / §4.6；制作指南：[`docs/games/game-package.md`](../docs/games/game-package.md)。

## 开工前八项表

| 项 | 答案 |
|---|---|
| 所有者 | `src/games/registry.ts`（`installFromZip` + 解包清洗/上限）、`packages/tavern-format/src/zip.ts`（通用解包，fflate 既有依赖）、`src/games/service.ts`（来源分发 + invalid 400 映射）、`src/games/http.ts`（`{zipBase64}` + 8MB 正文上限）、`client-src/30-games-ui.js`（GamesPanel 导入带）、`40/41-i18n`（10 键）、`docs/games/game-package.md`、gates/tests 各属其链路 |
| 唯一事实来源 | 导入后的事实不变：`games/installed/<id>/` 三件套 + 运行时注册表（成功路径以 `engine.meta` 为准）。zip 只是传输形态，解包落临时目录后立即复用 `installFromPath` 的全量校验与落地——没有新增持久格式 |
| 持久态及理由 | `games/installed/<id>/`（既有）：导入即落盘、可审计、可手删；额外文件随包保留（与目录导入同语义） |
| 临时态 | 上传 zip 的临时解包目录（`finally` 清理，成功失败都清）；面板 `importBusy`/状态行；8MB 请求正文峰值 |
| 外部依赖 | 无新 seam：复用 `webServer` 前缀路由与 `readModRequestBody`；fflate 经 tavern-format 的既有依赖进入 bundle（插件自身依赖面零变化，仍为零依赖包） |
| 注册入口 | `POST games/install` 增 `{ zipBase64 }`（与 `{path}`/`{url}` 并列）；面板「游戏」分区新增导入带（文件选择 + git 输入 + 覆盖勾选 + 状态行）；i18n `games.import.*`；gates server-bundle / frontend-runtime 标记 |
| 删除路径 | 删 `installFromZip` + `zip.ts` + 客户端导入带 + i18n 键 + 指南/决策文档 + gates 段即净；installed 数据不受影响，path/url 导入零迁移 |
| 兼容对象 | `{path}`/`{url}` 来源与语义不变；导入错误从无结构 500 → 结构化 400 `invalid`（消息原文保留，测试同步）；同名冲突与 `force` 语义不变；旧客户端不认识新键（无破坏）；旧 i18n 字典不受影响 |

## 落法

- **服务端（传输层）**：`tavern-format` 新增 `unzipArchive`（CHARX 同源 fflate，非法 zip 抛
  `ZipArchiveError`）；`registry.installFromZip` 做四步——base64 解码（宽容空白、非法字符
  可读拒绝）→ 解包 → 条目清洗（反斜杠归一；目录条目、`__MACOSX/`、`.DS_Store` 跳过；
  `..`/绝对路径/盘符拒绝；条目 ≤64、单文件 ≤2MB、总量 ≤4MB）→ 单层包装目录自动下潜，
  最终必须存在 `game.json`；落临时目录后复用 `installFromPath`（installed/<id>/ + 装载 +
  返回快照）。
- **服务端（面）**：`service.install` 增加 zip 分支并把用户输入类失败统一映射为
  `GameBridgeError('invalid')`（会话面/HTTP 面 400）；`http.ts` 的 `games/install` 接受
  `{ path } | { url } | { zipBase64 }`，正文上限 8MB（base64 约 4/3 膨胀），读取失败/坏 JSON
  也转 400 可读报错。
- **客户端**：GamesPanel 新增「导入游戏包」带——文件选择（`.zip`，5MB 预检，超限就地报错
  不发请求）→ 读字节转 base64 → `POST games/install { zipBase64 }`；git URL 输入框 + 安装
  按钮走同一 API；强制覆盖勾选；状态行区分进度/成功/失败（失败 `.dt-error` 透传服务端
  原因）。成功后 `loadList()` 重拉清单，新游戏立即可开局。
- **文档**：新增 `docs/games/game-package.md`（三件套规范、manifest 字段表、引擎契约与
  烟测五关、视图桥两条消息 + 最小骨架、四种导入方式、zip 上限、broken reason 排错表、
  参照实现与契约索引）；docs/README 增「开发者文档」分区与决策索引；根 README 同步。
- **顺带修复（存量 bug）**：GamesPanel 的 `loadList` 解构漏项（HEAD~1 起就存在）——面板点
  「开局」时 `.then` 里 `loadList()` 抛 `ReferenceError`，被 catch 成
  「loadList is not defined」错误行（对局实际已开局，会话列表不刷新）。本次把 `loadList`
  纳入解构并用客户端源检查锁住；导入成功后的刷新也走同一条路径。

## 与规格（提案 0018）的偏差

1. **§4.5 只承诺 `{url}`**（其余为手工放目录）；本次扩展 `{zipBase64}`——用户点名要
   「上传按钮」，而朋友分享的实际交付形态是 zip。既有目录/git 两条路径不动。
2. **传输层新增纪律**（§4.6 未规定）：条目 ≤64、单文件 ≤2MB、解包总量 ≤4MB；垃圾条目
   跳过；`..`/绝对路径拒绝；单层包装目录自动下潜一层；面板 5MB 预检 + 服务端 8MB 正文
   上限。上限是防滥用线，不是目标值（标准包只有三个小文件）。
3. **导入错误状态码收口**：此前 path/url 的坏包错误是无结构 500（外层兜底）；本次统一
   `GameBridgeError('invalid')` → 400，消息原文不变。与 `http.ts` 文件头「参数缺省 400」
   的既有契约一致。
4. **导入成功但包 broken（缺三件套/烟测不过）不算请求失败**：与目录导入语义一致——
   状态行「已导入」+ 清单 broken 条目连同 `reason` 展示；用户能看见原因并修包重导
   （镜像 mods 的「坏 Mod 不断路」语义）。

## 实弹摩擦与已知边界

- **fflate `unzipSync` 全量解压**：与 CHARX 卡导入同信任级；上限是解包后校验，不能防
  压缩炸弹的瞬时内存峰值。信任模型与 Mod 同级——指南明示「只导入你信任的来源」
  （提案 §6 原文纪律）。
- **自动下潜只剥一层**：多层包装（`a/b/game.json`）按「zip 内没有 game.json」拒绝，
  文案直接指向「直接压缩游戏包目录」，不猜路径。
- **额外文件随包落地**：zip 里的 README 等会拷进 installed（与目录导入一致）；运行时只
  消费三件套，额外文件不参与装载。
- **无启用开关 / 无卸载路由**：与 2026-10-13 偏差 8 一致——导入即生效；卸载仍是删目录 +
  `reload`（v1 不新增 uninstall 路由）。
- **客户端与服务端的体积对账**：5MB 文件预检 → base64 ≈6.7MB 正文 < 8MB 上限；两侧常量
  各自带注释指向对方，改一处必须同步另一处。

## gates

- **server-bundle**：+3 markers（`installFromZip` / `unzipArchive` / `zipBase64`）+ 3 负样本；
  self-test 的 `gamesBridge` 夹具同步补齐（缺一即自检自红）。
- **frontend-runtime**：+7 markers（`GAMES_ZIP_MAX_BYTES = 5 * 1024 * 1024`、`runGameImport` /
  `importGameZip` / `installGameFromGit` 三个入口、`accept: '.zip,application/zip'`、
  `api('games/install'`、`t('games.import.tooLarge'`）+ 7 负样本。
- **client-vm-mount**：自动覆盖新增 10 个 `games.import.*` 键的 zh/en 字典镜像与 `{param}`
  一致性（本批占位符：`{name}` / `{error}` / `{limit}`，两侧逐字相同）。
- **source-file-budget**：无新增豁免——`registry.ts` 403→496 行、`30-games-ui.js` 507→594 行，
  均低于 800 行预算。
- `REQUIRED_SERVER_ROUTES` 无变化（`games/install` 早已锁在名单内）。

## 测试对账

| 阶段 | 基线 |
|---|---|
| 变更前 | 107 文件 1789 过 +1 跳 |
| 变更后 | **107 文件 1795 过 +1 跳**（+6：games-import +4、games-service +1、games-client +1） |

新增用例：zip 直装（含 macOS 垃圾条目跳过与落盘核对）、单层包装下潜、坏 zip/非 base64/
缺 `game.json`/路径穿越四类可读拒绝（含 `GameBridgeError` 类型断言）、条目数上限；
HTTP 面缺来源 400 与坏 zip 400（结构化错误不落 500）；客户端导入口 markers + `loadList`
解构回归锁 + 近邻负样本。

`pnpm run check` exit 0（tsc 零错 + vitest 全绿 + 构建 + 16 gates 全 PASS）。
