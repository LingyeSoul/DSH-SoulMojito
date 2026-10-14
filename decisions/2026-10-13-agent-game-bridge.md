# Agent 游戏桥 P0–P3 落地（提案 0018 实施）

> 日期：2026-10-13。设计契约：[提案 0018](../docs/proposals/0018-agent-game-bridge.md)（含
> §9 五子棋参照实现补记）。本文记录四阶段实施的单次决策——分层落法、与规格的偏差、
> 实弹摩擦与已知边界。前置：同日早些时候已交付标准参照游戏包
> `examples/games/dsh-tavern.gomoku/` + `tests/games-gomoku.spec.ts`（29 用例，基线
> 90 文件 1305 过 +1 跳），本文从 P0 起算。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/src/games/`（8 文件：standard/registry/sessions/handle/service/http/view/builtin）为运行时单一 owner；`src/agent-tavern/agent.ts` 四工具与 -63 懒段、`src/index.ts` apply 接线（服务打开 + 路由分派 + **Mod 装载串行在游戏服务落定之后**）、`src/mods/host.ts` api.games 面、`client/main.js` games 分区 + GameSurface，各属其链路 |
| 唯一事实来源 | 会话状态 = `$DSH_HOME/tavern/games/sessions/<sid>.json`（引擎无状态纯函数，重启重建）；游戏定义 = 运行时注册表（builtin/imported/mod 三源合一，成功路径以 engine.meta 为准） |
| 持久态及理由 | sessions JSON（跨重启续局 + moves 全量留档可审计重放）；`games/installed/<id>/` 导入目录（可审计、可手删） |
| 临时态 | 引擎模块实例（reload 用 `?v=<mtimeMs>` 防缓存）、globalThis 服务句柄（sequence 守卫摘除）、面板 1s revision 轮询、iframe per-mount token——均可失 |
| 外部依赖 | 全部现有 seam：`webServer` 前缀路由、`tools.register`、`systemPrompt.section`；跨 bundle 经 `Symbol.for('dsh-tavern:games-service')` 句柄（镜像 mods/cross-bundle 纪律）；零新网络面、零新宿主能力 |
| 注册入口 | HTTP `/api/dsh-tavern/games/*` 九路；agent.ts `createTools()` 四件 + `BUILTIN_TOOL_NAMES_SEED`（18→22）；client `registerPanelSection` games 分区（mods 前）；mods `api.games.register` + manifest `games` 字段；写穿总线 `dsh-tavern:games-changed-listeners` |
| 删除路径 | 工具/懒段随 effect 反注册；服务 dispose 摘句柄；`games/` 目录整体可删（sessions+installed 均无迁移、state.json 不动）；Mod 卸载自动反注册其游戏；gates marker 与五份 games-*.spec 按名可删 |
| 兼容对象 | 62→66 内置工具名不冲突；Mod API v1 只增（`games` 可选字段 + `api.games` 新键）；三个既有锁定测试同步（tools 名单+22、mount 计数、prompt-viewer 六段表）；`storeRevision` 语义零改动 |

## 落法（四阶段，每段独立闭环）

- **P0+P2 服务端**（`src/games/` 1853 行 + 测试 4 文件 62 用例）：引擎契约 TS 化
  （standard.ts：duck 校验 + `smokeTestGameEngine` 五关烟测 + actor 推导 + 64KB/4KB/64
  尺寸常量）；三源注册表（installed 扫描 + `?v=mtime` 防缓存 + broken 入册不崩）；
  会话生命周期（读-改-写串行队列防并发丢手、`writeFileAtomic` 落盘、revision 只 stat
  不读内容、孤儿判定动态查表、resign 运行时统一处理）；HTTP 九路（`GameBridgeError` →
  404/409/400/503 映射）；Agent 四工具（`resolveGamesService` 小 seam 逐调用解析句柄，
  agent bundle 不拖运行时图）+ order -63 懒段（仅未终局会话注入，过 hostPromptSafe）。
- **P1 客户端**（client/main.js +354 行 + games-client.spec 7 用例）：games 分区
  （清单/开局/会话卡/来源徽标）+ GameSurface（ModSurface 范式：per-mount token、
  message 双检、高度 clamp 80..1200、viewport 桥）；刷新 = `games/revision` 1s 轮询
  （仅分区挂载且存在未终局会话时，`visibilitychange` 停发/回前台补拍）；人类落子 POST
  成功即本地回填 + 立即下行 `game-state`（轮询只兜 Agent 侧落子）。
- **P3 Mod 扩展**（manifest games 校验 + host api.games + registry registerModGame +
  `examples/mods/dsh-tavern.rps/` 猜松示例 + games-mod.spec 8 用例 + mod-api.md §18）：
  id 双重门（`<modId>.` 前缀 + manifest `games` 声明，镜像 buttons「未声明即拒」）；
  注册期双子段对账 + 引擎烟测 fail-fast（抛错 = Mod setup 失败，不带病入册——setup 抛错
  走 runDisposers 回滚已注册面）；反注册带引擎实例身份对账（reload 后旧 off 触新注册是
  no-op）；卸载 → 游戏摘册 → 会话孤儿化（动态查表，重装载自动恢复可玩）。
- **生产装载顺序修正**：index.ts 的 Mod 装载从「与游戏服务并发」改为
  `gamesServicePromise.catch(() => {}).then(() => modHost())` 串行——注册游戏的 Mod 在
  setup 期就要句柄，原顺序存在竞态窗口。防漂移守卫（tavern-mods-examples.spec）同步镜像
  生产拓扑（先开游戏服务再装 Mod），否则 rps 示例在守卫里成假错误位。

## 与规格（提案 0018）的偏差

1. **内置游戏缩为井字棋一个**（§4.1 说「井字棋+五子棋」）：examples/ 不在 package.json
   `files` 内不随包分发，五子棋已是导入参照包——双份维护是负资产。三源各有证明：
   builtin=井字棋、imported=五子棋示例、mod=猜松示例。
2. **v1 会话恒「一人类一 Agent」**：`players.max !== 2` 一律拒（§6 ① 的收紧落地），
   报错说明裁剪；开局 humanRole 缺省 roles[0]（人类先手），`game_start` 的 role=Agent
   执方缺省 roles[1]。
3. **`game_state` 缺省寻址 = 最近活跃**（§6「歧义时返回列表」简化未做）；列表经
   `game_list` 可得。
4. **`state.turn` 明文为 v1 运行时补充契约**：提案 §3.2 未规定 state 形状，但「actor 恒
   等于当前回合角色」需要可读回合字段——standard.ts `currentRoleOf` + 烟测强制 + 两参照
   引擎天然满足。
5. **sessionId 与既有身份契约的豁免**：agent-tavern-tools.spec 原锁「全部工具无
   sessionId 参数」，`game_state/game_move` 按提案 §4.2 带可选 sessionId——豁免 `game_*`
   前缀并注释（binding 过滤后的对象寻址，非身份参数）。
6. **install {url} 走真实现**（复用 mods/install.ts 的 parseGitSource/gitClone，
   cloneImpl 可注入测试），未按任务书降级为「400+手动指引」。
7. **内置清单不带 engines**：同进程分发自我门控无意义（且插件 0.5.1 过不了示例的
   ^0.6.0）；engines 只作用于导入包——五子棋示例在宿主 0.5.1 下导入会如实 broken
   「版本不满足」，标准发布对齐宿主版本时须同步示例 engines。
8. **游戏无启用开关**（无 mods 三层开关对应物）：builtin 恒载；imported 删目录 + reload
   即除；无 uninstall 路由 v1（手动清理，sessions/installed 整目录可删无迁移）。

## 实弹摩擦与已知边界（如实）

- **孤儿化不推进 revision**：revision 只 stat sessions 目录，卸载游戏/Mod 不动会话文件——
  面板孤儿卡要等用户下次动作（落子 503）或 1s 轮询里 state 重取才翻转。接受边界：孤儿是
  罕见路径且 503 message 原文透传可解释。
- **409 双载语义**：非人类回合与终局后落子同用 409（sessions.ts 同一 turn code）——客户端
  统一映射「现在轮到 AI」横幅，竞态（AI 刚终局、用户点旧盘）下措辞不精确，1s 轮询收敛为
  结果卡。
- **首条下行时序是硬约束**：view.ts 桥脚本只在收到消息后才置 latest，宿主必须在 iframe
  load 事件后投递初始局面（props 变化 + load 双时机投递）。
- **esbuild 中文转义坑**：gate marker 必须全 ASCII（中文字符串会被转义 `\uXXXX` 导致
  marker 失真——server-bundle gate 实测坑留档；当前 client 构建中文以 UTF-8 原文输出，
  但纪律保持 ASCII）。
- **实施中修掉的实弹 bug**：井字棋 `findWinLine` 单步 `if` 而非 `while` 延伸（端锚三连
  漏检）；broken 游戏误用 engine.meta 做 key 会吞同名好游戏槽位（失败路径改目录一致清单）；
  引擎非法动作未包 GameBridgeError 会 500 而非 400。
- **烟测探测保留动作**：`smokeTestGameEngine` 要求引擎对 `{type:'resign'}` 与未知动作
  抛错——引擎静默接受 resign 会被拒（resign 由运行时处理，防止双路径语义分叉）。
- **一次性未复现失败**：P3 收尾后首次全量出现 1 处失败（1381/1382），随后两次连续全绿
  （96 文件 1382 过 +1 跳）；仓库已知存在 mtime/timing 偶发族，留档观察，未定位到
  确定性根因。

## gates

- `REQUIRED_SERVER_ROUTES` +8 条 games 路由；server-bundle 增 games 标记块
  （`dsh-tavern:games-service` / `smokeTestGameEngine` / `orphaned` / view 段）+ 4 负样本。
- `agent-tavern-isolation` 增 agent.mjs 产物面六标记（四工具名 + 懒段 + 句柄）+ 3 负样本
  （在既有 gate 内补，未造新 gate）。
- `frontend-runtime` 增 9 个 ASCII marker（game-state/game-action 消息、六路由字面量、
  GameSurface/GamesPanel、`panel.section.games`）+ 10 负样本；client-vm-mount 真装载新
  分区代码验证 i18n 镜像与占位符。

## 测试对账

| 阶段 | 基线 |
|---|---|
| 五子棋参照包（同日前置） | 90 文件 1305 过 +1 跳（+29） |
| P0+P2 服务端 | 94 文件 1367 过 +1 跳（+4 文件 62 用例） |
| P1 客户端 | 95 文件 1374 过 +1 跳（+1 文件 7 用例） |
| P3 收尾 | **96 文件 1382 过 +1 跳**（+1 文件 8 用例） |

`pnpm run check` exit 0（tsc 零错 + vitest 全绿 + 构建 + 15 gates 全 PASS）。新增测试
文件：games-{builtin,service,import,tools,client,mod}.spec.ts + games-gomoku.spec.ts。

## 2026-10-14 修订：game_wait 阻塞等待 + 对局面 MVU 同位自动展示

需求源：用户对交互模型的修正——①游戏自动显示在与 MVU 状态同位的地方；②Agent 拿到
wait 工具，用户完成游戏操作后工具返回、Agent 自动续弈，不需要用户发消息触发。设计
论证与工具语义见提案 0018 §10（补记）；本节只记实施决策与偏差。

- **wait 工具**：`game_wait` 挂在 agent bundle（`waitForHumanMove` 循环：快照判定 →
  三路信号等待——`onGamesChanged` 事件主路、1s tick 兜底、`exec.signal` 中止）。
  `timeoutMs` clamp 1000..900000 缺省 300000（下界为可测性，上界防焊死回合）；超时
  返回 `status:'timeout'` 不报错；中止与其它工具同款 `throwIfAborted` 语义。教学三处
  （game_start/game_move 描述 + -63 懒段指引行）。种子 22→23。
- **假服务修正**：games-tools.spec 的内存假服务补 `emitGamesChanged`（start/落子成功
  后，镜像真服务 service.ts）——wait 的唤醒路径依赖该 emit 跨监听器可见，初版假服务
  不 emit 是「工具面只读不订阅」时代的简化，wait 之后不再成立。
- **对局面三面**：ST 内联 `TavernGameBoard`（MVU 卡之后）；AgentTavern 右栏 tab
  `tavern-games`（MVU tab 同款注册）+ 标题栏 watcher 自动展开（1s revision 盯守、
  每会话一次）；管理分区保留为入口与导入面。数据面抽 `useChatGameSessions` 共用。
  终局结果卡只展示本挂载期间见证过的对局（防翻旧账占位）。
- **与 2026-10-13 偏差 7 的联动**：版本 0.5.1→0.6.0（根与插件 package.json），五子棋
  示例 engines `^0.6.0` 的版本门控自此可通过导入校验（初版「0.5.1 过不了」的如实
  标注随之作废）。
- **已知边界**：等待期间宿主会话保持 busy（wait 是回合内挂起）；宿主若对单次工具有
  更短超时会提前打断 wait（宿主行为，插件不覆盖）；AgentTavern 自动展开 watcher 是
  常驻 1s revision 轮询（stat-only 端点，与 games 面板活跃轮询同量级）。
- **连带加固（产品级修复）**：假服务补 emit 后，games-tools -63 段用例以 ~1/3
  概率复现出一颗存量雷——`lazy-projection.ts` 的票号护栏在「新票已开工」时丢弃
  旧 settle，写穿 emit 的 fire-and-forget 刷新与工具内 await 的显式刷新并发时，
  后者的落值被在途新票压制，`await refreshWhere` 返回而缓存仍停留旧值（games
  懒段在 game_start 返回后短暂不可见）。修法：装载链按 agentId 串行化
  （enqueueLoad）——排尾装载必然最后落值且重读最新状态，await 语义恢复为真；
  修复后 25 连跑零复现，全套 projection（facts/guides/script/games/preset）
  共享该加固。
- **实弹修复（用户首测反馈：侧边栏游戏对局 tab 渲染为空）**：RCA 两层——①共用
  hook `useChatGameSessions` 没有自己的挂载加载（效应留在 GamesPanel 组件内），
  右栏 tab/ST 内联经 hook 消费时从未拉取 list、恒渲染 null；②「无活跃会话不
  轮询」与「会话只能靠加载出现」互为鸡生蛋（tab 已开时 openTab no-op 不重挂载，
  Agent 在对话里开局后棋盘永远不出现，该坑初版 GamesPanel 就存在）。修法：
  加载/games/listError 收进 hook 自持；轮询两档（对局中 1s / 守望 5s，基线跨档
  保留）；侧边栏空态指引（games.boardEmpty，内联变体维持不占位）。
- **二次修订（用户二测反馈三件）**：①侧边栏自动刷新——RCA 为水位基线后置于
  数据拉取的漏更新窗口，修法「先 await 基线再拉数据」（串行序，不变式：基线
  严格早于数据读取）；②标题栏加与 MVU 同位同款的游戏入口（openGamesSurface：
  右栏 tab 优先，旧宿主/开 tab 失败回落设置面板游戏分区；ST 走内联对局面）；
  ③空态升级卡片（图标 + 标题 + 指引 + 打开面板按钮；dt-game-board-empty 样式
  + games.openPanel 键）。gates 负样本实测坑：games/list 子串出现在链式基线
  marker 中，单次 replace 的负样本被幸存 marker 救活，改全量替换（split/join）。
- **测试**：games-tools 8→14（wait 六路 + 懒段 game_wait 断言）、games-client 7→12
  （内联顺序/tab 注册/旧文案负样本）、agent-tavern-tools 名单 22→23 + mount 计数
  22→23；gates agent-tavern-isolation +`game_wait` marker/负样本、frontend-runtime
  +5 marker/4 负样本。版本 0.6.0 连带：story-clock 示例清单 `^0.5.0`→`^0.6.0`
  （spec 断言改从 PLUGIN_VERSION 推导，drift guard 语义不变）、mod-api.md 示例值
  同步。基线 96 文件 1391 过 +1 跳（+9）。
