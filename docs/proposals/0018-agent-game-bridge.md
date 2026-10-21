# 提案 0018：Agent 游戏桥——标准游戏引擎 + 侧边栏对局面 + Mod/导入扩展（设计）

> 状态：**已实施（P0–P3）**，实施决策与偏差见 [decisions/2026-10-13-agent-game-bridge.md](../../decisions/2026-10-13-agent-game-bridge.md)。
> 需求源：2026-10-13 用户——Agent 模式下与 Agent 玩 HTML 游戏；
> 为 Agent 提供工具与插件运行的游戏交互；游戏 HTML 显示在原侧边栏；提供工具↔游戏的
> 交互标准；支持 Mod 提供更多游戏；符合插件自有标准的游戏可直接导入。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 回答 |
|---|---|
| 所有者 | 新模块 `src/games/`（注册表 + 会话运行时 + HTTP 面），agent-tavern `createTools()` 挂工具，客户端 `registerPanelSection` 挂「游戏」分区，mods host 挂 `api.games.register`——四条链路同属本提案的单一特性 owner |
| 唯一事实来源 | 对局状态以 `<data root>/games/sessions/*.json` 为准（新装 `$DSH_HOME/soulmojito`，旧装 `$DSH_HOME/tavern`；JSON-safe 契约保证）；游戏定义以运行时注册表为准（内置 + `games/installed/` 导入 + Mod 注册三源合一） |
| 持久态及理由 | 会话 JSON（跨重启续局、可审计重放——动作日志完整保留）；`installed/<id>/` 游戏目录（导入即落盘，镜像 `mods/install.ts` 纪律） |
| 临时态 | 引擎是无状态纯函数（状态全在会话 JSON，重启重建零损失）；view iframe 的 per-mount token；面板轮询节奏。均可接受 |
| 外部依赖 | 全部现有 seam：DSH `webServer` 前缀路由、`tools.register`、`systemPrompt.section`；**零新网络面**（视图自包含 HTML，CSP `connect-src 'none'`） |
| 注册入口 | HTTP `/api/dsh-soulmojito/games/*`（list/revision/start/state/action/view/install）；agent.ts `createTools()` + `BUILTIN_TOOL_NAMES_SEED` 四名；client `registerPanelSection`；mods `api.games.register` + cross-bundle globalThis 注册表 |
| 删除路径 | 工具/提示段经 `ctx.effect` 反注册；分区 unregister；路由随插件卸载；`games/` 目录整体可删无迁移（state.json 不动——games 独立文件）；Mod 卸载自动摘除其注册的游戏；测试/gates 按新增清单删 |
| 兼容对象 | 现有 62 内置工具名不冲突（`game_*` 前缀全新，查重面 `cross-bundle.ts` 种子）；Mod API v1 只增不改（`api.games` 为可选新增面）；`state.json`/storeRevision 语义不动 |

## 0. 目标行为（Working Backwards）

**PR（用户视角的一天）**：用户在酒馆里和角色聊天下棋。「来局五子棋？」角色调 `game_start`，
**棋盘自动出现在与 MVU 状态同位的地方**（ST 架构在聊天视图 MVU 状态卡下方；AgentTavern
架构是 DSH 原生右侧栏「游戏对局」tab，开局自动展开），立即可点。用户点子后，角色调
`game_move` 落子并用带棋风的语气叙述这手棋（工具返回 `describe` 文案），随后调
`game_wait` **在自己回合内挂起等待**——用户在棋盘上落子，工具即返回人类那一手与最新
局面，角色同回合自动续弈 narrate + 落子，**全程不需要用户发送聊天消息触发下一步**
（2026-10-14 修订；初版设计骑聊天回合、面板提示「发送任意消息唤 AI」，已被用户
反馈推翻，见 §7-4 与 §10）。用户关掉浏览器第二天回来，局面原样。用户从面板导入朋友
按公开标准写的斗地主，装上就能和 Agent 打。Mod 作者在自己 Mod 里
`api.games.register` 注册一个剧本杀小游戏，面板与工具自动可见。

**双客户倒推**（本提案的第一性起点）：
- **客户一：Agent（工具调用方）住在 Node 侧**——工具 execute 在 Node 进程内执行（`agent.ts:203-214`），
  它要的是同步、快速、可无头对局的状态读写。
- **客户二：人类玩家（观看/落子方）住在浏览器**——他要的是可点的棋盘和 1 秒级刷新。

两个客户没有共享的执行环境，而**插件刻意不引入 SSE/推送通道**（`client/main.js:2047-2050`
注释、`docs/mods/mod-api.md` 明示）。结论见 §1。

## 1. 第一性约束：权威游戏状态必须在 Node 侧

三条既有事实合起来唯一确定了架构：

1. **Agent 工具在 Node 执行**，且工具必须能独立于任何浏览器会话工作（Agent 无头对局、
   后台陪玩都是合法场景）。
2. **无 Node→客户端推送**：客户端靠 `store-revision` 轮询感知服务端变化
   （`main.js:2047-2054`、`src/index.ts:785-788`），且 `storeRevision()` 只摘要资产目录、
   **刻意不含 state.json/chats**（`tavern-store/src/store.ts:374-387` 注释原文「chats/ 有各自的
   CAS revision、state.json 由面板写路径自行刷新，都不参与」）——游戏落子骑这个水位会逼全
   面板重取 bootstrap，且污染既有语义。
3. **iframe 桥只有「iframe→宿主→Node HTTP」正向代理**（`dsh-soulmojito:mod-request`，
   `main.js:466-488`）和有限下行广播，没有任何「工具→客户端→iframe→回结果」的同步回路。

因此：**游戏逻辑（规则、合法性判定、终局判定）以引擎模块形式跑在 Node 进程内，
会话状态以 JSON 落盘；侧边栏 iframe 是纯视图 + 人类落子入口**。Agent 落子 = 进程内函数调用
（微秒级）；人类落子 = iframe postMessage → 宿主 → `POST /games/<sid>/action`（既有 mod-request
同款正向路径）；显示刷新 = games 专属轻量 revision 轮询（镜像 store-revision 的便宜纪律，
仅游戏分区开且对局活跃时以 1s 节奏轮询）。浏览器关掉期间 Agent 照常下棋，人类重开面板即追平。

## 2. 既有事实盘点（挂载点坐标，2026-10-13 探索结论）

- 工具注册：`agent.ts:148-152` 循环 `ctx.tools.register`，mount 级生命周期；`tool()` 工厂
  `agent.ts:941-955`（JSON 输出 + render text）；参数校验助手 `tool-args.ts:15-34`。
  新内置工具名须进 `BUILTIN_TOOL_NAMES_SEED`（`mods/cross-bundle.ts:77-95`，`game_*` 前缀当前空闲）。
- 提示注入：`apply()` 内 `ctx.systemPrompt.section`，现有顺序 -80 KERNEL（`agent.ts:57-92`）
  / -75 preset / -70 facts / -65 guides / -64 script 进度——游戏段插 -63。
- iframe 三件套现成：`FrontendFrame`（srcDoc + sandbox allow-scripts，`main.js:267-292`）、
  `ModSurface`（http src + token + postMessage 桥，`main.js:433-489`）、mod HTML 服务管线
  （CSP + 控制台上报 + viewport 下行 + 高度上行 + vh 重写，`mods/http.ts:122-335`）——视图服务整体复用。
- 面板分区：`registerPanelSection`（`main.js:6476-6484`）+ 17 个内置分区（`main.js:6486-6513`），
  Mod 动态分区 `syncModPanelSections`（`main.js:516-535`）给出签名 diff 防重挂的先例。
- Mod 面：`createApi`（`mods/host.ts:585+`）已有 tools/prompt/http/onButton 等注册面；
  Mod 无静态文件服务（UI 只能内联字符串，mood-tracker `UI_PAGE` 先例）——**本提案给 Mod 的
  游戏注册同样走内联（engine 模块对象 + view HTML 字符串），不开静态文件面**。
- 安装先例：`mods/install.ts` git 拷贝 + `POST /mods/install {url}`，`engines` 半开区间门控
  （`satisfiesVersionRange`，0.x 陷阱见 decisions/2026-10-12-story-clock-engines-drift.md）。

## 3. 游戏桥标准 v1（dsh-soulmojito Game Bridge，对外的公共契约）

一个「标准游戏」= 一个目录：`game.json`（清单）+ `engine.mjs`（纯逻辑 ESM）+ `view.html`
（自包含渲染页）。三份文件构成可独立分发、可被任何工具/视图消费的游戏包。

### 3.1 清单 game.json

```json
{
  "id": "com.example.gomoku", "name": "五子棋", "version": "1.0.0",
  "engines": { "dsh-soulmojito": "^0.6.0" },
  "players": { "min": 2, "max": 2, "roles": ["black", "white"] },
  "turnBased": true,
  "actionVocabulary": "落子 {type:'place', x, y}；认输 {type:'resign'}"
}
```

`id` 反域名（同 Mod 纪律）；`engines` 复用现有版本门控；`turnBased` v1 恒真（实时游戏明确裁剪）。

### 3.2 引擎契约（Node 侧，权威）

`engine.mjs` 默认导出一个**无状态纯函数对象**：

```js
export default {
  meta: { /* 同 game.json 冗余字段，运行时以此为准 */ },
  // 开局：options 含 seed；返回初始 state（必须 JSON-serializable）
  createGame(options) { return { state } },
  // 当前行棋方的动作建议集（有界 ≤64，超出的游戏自行抽象；**是给模型/视图的提示，
  // 不是合法性依据**——applyAction 按全量规则终审任意动作。2026-10-13 五子棋参照
  // 实现补记：原文「合法动作」措辞会造成"列表即全集"的误读，若运行时拿它门控
  // Agent 动作会静默缩小动作空间，故改称建议集）
  legalActions(state) { return [action] },
  // 施加动作：引擎自证合法性（Node 权威，iframe 不可作弊）；必须纯且确定
  applyAction(state, action, actor) { return { state, events, finished, winner, summary } },
  // 人类可读的一手棋描述——Agent 用它在对话里角色化叙述
  describe(state, actor, action) { return '黑棋天元落子' },
}
```

硬约束（导入期烟测强制，见 §4.6）：state 任意时刻 deep-JSON-safe（持久与重放的根基）；
`applyAction` 同输入两次调用结果 deep-equal（确定性——需要随机的游戏用 `options.seed` 自行
派生确定性 RNG，如 mulberry32）；`applyAction` 对非法动作抛错而非静默；state 序列化上限
64KB（棋盘类天然满足，防滥用）。保留动作类型：`resign`（认输）由运行时统一处理，不必进引擎。

### 3.3 视图契约（iframe 侧，人类面）

`view.html` 自包含（mod CSP 同款：仅内联脚本、`connect-src 'none'`、无外链），运行时由视图
服务注入桥脚本（token + 高度上报 + viewport 桥，复用 `mods/http.ts` 管线）。协议只有两条消息：

- 下行 `dsh-soulmojito:game-state {token, session, view:{state, turn, legal, finished, summary}}`
  ——全量
  状态投递（v1 不做增量），iframe 负责渲染并高亮可落子点。
- 上行 `dsh-soulmojito:game-action {token, action}`——人类落子；宿主校验 token 与
  `event.source`（同 `main.js:450-456` 纪律）后代理 `POST /games/<sid>/action`，**合法性由
  Node 侧引擎终审**，iframe 说什么不算。

### 3.4 动作语言

动作 = 游戏自定义 JSON 对象（如 `{type:'place', x:7, y:11}`）。标准只规定：JSON-safe、
单动作 ≤4KB、必须有 `type` 字符串字段；词汇表在 `actionVocabulary` 里用一句话写给人/模型看。
工具结果与视图投递共享同一份动作语言——**这就是「Agent 工具与 HTML 游戏的交互标准」本体：
Agent 和人类玩家走完全相同的动作语言、相同的引擎合法性判定，二者只是两个不同的动作入口。**

## 4. 设计

### 4.1 会话运行时（`src/games/`）

- `registry.ts`：三源注册表（内置 / 导入目录 / Mod 注册），统一 `{source, manifest, engine, view}` 形态；
  导入目录与 Mod 注册的游戏经 `globalThis[Symbol.for('dsh-soulmojito:game-registry')]` 跨 bundle
  可见（镜像 `mods/cross-bundle.ts` 纪律——agent bundle 与 index bundle 无共享模块态）。
- `sessions.ts`：会话生命周期。会话 = `{id, gameId, players:[{role, owner:'human'|'agent'}],
  state, moves:[{actor, action, at, summary}], createdAt, updatedAt, chat:{character, chatId}}`，
  按聊天绑定（与 MVU/记忆同款作用域），存 `games/sessions/<hash>.json`，写路径用
  `writeFileAtomic`（apply.ts 同款）。开局默认人类执先、Agent 执后（面板开局）/Agent 自选
  （`game_start` 可传 role）。
- `http.ts`：前缀路由 `/api/dsh-soulmojito/games/*`——`GET list`（游戏 + 本聊天活跃会话）、
  `GET revision`（sessions 目录元数据摘要，镜像 `storeRevision` 的便宜性——**只 stat 不读内容**，
  游戏分区专用 1s 轮询，不动全局水位）、`POST start`、`GET state/:sid`、`POST action/:sid`、
  `GET :gid/view/:sid`（视图服务，§4.4）、`POST install`（§4.5）。
- `builtin/`：首发两个内置游戏——井字棋、五子棋（纯函数引擎各 ~100 行 + 自包含 view）。
  内置引擎随 bundle 静态 import，view 以字符串常量内联（mood-tracker `UI_PAGE` 先例），
  因此内置游戏零文件依赖、随插件分发。

### 4.2 Agent 工具面（agent-tavern `createTools()` 六件 + 懒提示段）

**token 经济纪律（2026-10-14 用户裁定「游戏系统尽可能考虑 token 经济性」，§14）**：
所有工具载荷扁平、字段最小——身份面（players/动作词汇表）只在 `game_list`/
`game_start` 出现一次；回合载荷只带「下一步动作与叙述」所需；棋盘与动作日志分别
只经 `game_state` / `game_history` 读取；审计字段（move.at/summary）与时钟/聊天
绑定不进载荷（盘上记录原样完整）。

| 工具 | 语义 |
|---|---|
| `game_list` | 游戏（id/名称/人数/动作词汇表）+ 本聊天会话（sessionId/游戏名/轮到谁/终局态/手数） |
| `game_start` | `gameId, role?`——开局并绑定本聊天；返回会话身份（sessionId/游戏名/players 角色归属/先手方）——**不含棋盘**（局面需要时经 game_state 读） |
| `game_state` | `sessionId?`（缺省取本聊天最近活跃会话）——扁平局面面：`state` 棋盘、`legal` 建议集、`turn/turnOwner`、`moveCount`、`finished/winner/summary`；不含日志 |
| `game_history` | `sessionId?, from?, limit?`——动作日志窗口（**2026-10-14 新增，§14**）：`limit` 夹 1..200（缺省 20），`from` 为 0 基窗口起点；每条 `{actor, action, describe}` |
| `game_move` | `sessionId, action`——Agent 落子；返回 `describe` 叙述文案 + 轮次/终局态（`finished/winner/summary`）——不回吐棋盘与日志；非本方回合报错并告知轮到谁 |
| `game_wait` | `sessionId?, timeoutMs?`（限 1000..900000，缺省 300000）——**在自己回合内阻塞等人类落子**（2026-10-14 修订，§10；同日 token 经济修订 §14）：人类动作经 `dsh-soulmojito:games-changed-listeners` 跨 bundle 写穿唤醒（1s tick 兜底），返回 `{status, sessionId, newMoves, turn?, turnOwner?, winner?, summary?}`——只给**等待期增量**（`newMoves` 即等待期间到达的手，通常是人类刚落那手）；超时不报错（模型可再 wait）；用户停止生成时随 `exec.signal` 中止 |

全部走 `tool()` 工厂 + `tool-args.ts` 校验助手；六个名字进 `BUILTIN_TOOL_NAMES_SEED`。
提示段：`apply()` 新增 order `-63` 懒段——**仅当本聊天存在活跃会话时注入**（无对局零 token
消耗）：一句话局面摘要（局面 id、轮到谁、动作词汇表）+「轮到你时先 game_state 读局面、再
用 game_move 落子；落到人类回合立即调用 game_wait 阻塞等待（对方无需发消息；wait 只返回
等待期增量），返回后自动继续；往手用 game_history 查询」（2026-10-14 增量修订，§14）；文本过
`hostPromptSafe`（`agent.ts:76-92` 纪律）。

**与聊天回合的交织（2026-10-14 修订后）**：AgentTavern 会话由宿主原生 AgentLoop 驱动，
工具 `execute` 的 Promise 就是挂起面——`game_wait` 在 agent 自己的回合内挂起，人类落子
（HTTP `POST games/action/:id` → 服务 `emitGamesChanged`）唤醒，agent 同回合续弈。等待
期间宿主运行保持 busy（用户仍可在棋盘上落子；停止生成即中止）。若模型终局前主动结束
回合（未 wait），旧「骑聊天回合」行为仍是兜底：下次任一消息唤起时懒段提示局面。

### 4.3 客户端对局面（「游戏」分区 + MVU 同位自动展示）

对局面的展示面（2026-10-14 修订，与 MVU 状态同位的三面）：

- **ST 架构**：`TavernGameBoard` 内联挂在聊天视图 `TavernMvuStatus` 之后、剧本进度卡
  之前——本聊天存在未终局对局即自动占位渲染棋盘，无对局返回 null 不占位。
- **AgentTavern 架构**：对局面注册为 DSH 原生右侧栏 tab（`tavern-games`，MVU tab
  `tavern-mvu` 同款 `sidebarRightTabs.register` + keyed slot 姿势）；标题栏 watcher
  盯 `games/revision` 水位（1s、页面不可见停发），本聊天出现未终局对局即自动展开
  tab——每个会话只自动展开一次（用户关掉后不抢焦点）；也可从右栏「+」guide 手动进入。
- **设置面板「游戏」分区**（管理面，原有）：游戏清单（内置 + 导入 + Mod 来源徽标）、
  「开始对局」入口、导入；会话卡与对局面共用同一份数据面（`useChatGameSessions`：
  list 过滤 + 未终局快照补拉 + revision 1s 轮询 + 落子回填）。

活跃对局渲染 `GameSurface`——`ModSurface` 模式的持久 iframe（`src` 指向
`GET games/:gid/view/:sid?token=`，per-mount token，签名 diff 防重挂）。

刷新（2026-10-14 修订为两档）：任一展示面挂载即轮询 `GET games/revision`——存在未终局
会话时 1s（AI 落子 ≤1s 可见），无活跃会话时 5s 低频守望（等「Agent 在对话里开局」出现；
tab 已开时 openTab 是 no-op 不触发重挂载，空档位停摆会让面板饿死——首版把挂载加载留在
GamesPanel、对局面经共用 hook 消费时从未拉取，右栏 tab 恒空白的教训）；**加载由
`useChatGameSessions` 自持**（挂载/绑定变化各一次）。水位变化即重取 state 并 postMessage
下行 `game-state`（人类自己落子的即时反馈走 action 响应直接下行，轮询只兜 Agent 侧落
子）。卸载即停轮询。**不引入 SSE，不动全局 3s bootstrap 轮询**。

### 4.4 视图服务（复用 mod HTML 管线）

`GET games/:gid/view/:sid` 返回 view.html，服务端注入：CSP meta、token 桥脚本（含 game-state
下行监听与 game-action 上行）、高度上报、viewport 脚本、vh 重写——全部复用/参数化
`mods/http.ts:122-335` 现有件，不新写第二套。token 一次性按 (sid, mount) 校验，iframe 无法
越权操作别的会话。

### 4.5 三条游戏来源

1. **内置**：§4.1，随插件分发，卸载插件即消失。
2. **直接导入（标准游戏包）**：目录放入 `$DSH_HOME/soulmojito/games/installed/<id>/`（旧装 `$DSH_HOME/tavern/…`），或面板
   `POST games/install {url}`（git 拷贝，镜像 `mods/install.ts`）。校验通过即出现在注册表
   与 `game_list`，面板可见。**信任模型与 Mod 完全同级：导入即执行**（见 §6）。
3. **Mod 注册**：`api.games.register({id, name, version, players, turnBased, actionVocabulary,
   engine, view})`——engine 是进程内模块对象（Mod 代码本就无沙箱进程内运行，无新增信任面），
   view 是 HTML 字符串（Mod 无静态文件服务，维持内联纪律）。Mod 卸载自动反注册；其活跃
   会话标记 `orphaned`（状态保留可查看、不可续弈，面板如实展示原因——镜像 Mod 工具卸载语义）。

### 4.6 导入校验（烟测）

清单结构校验（字段/类型/engines/players 范围）+ 引擎导入后执行一致性烟测：`createGame` 出
JSON-safe 初始态 → `legalActions` 有界 → 取首个合法动作 `applyAction` 连打两次 deep-equal
（确定性）→ 非法动作必须抛错。view 做静态检查（无外链 script/无 fetch 字样——CSP 在服务期
兜底，这里只提前给出可读报错）。任一不过即拒绝安装并回传逐项原因（PUT fail-fast 纪律同款）。

## 5. 阶段划分

- **P0 无头可玩**：`src/games/` 运行时 + 契约 + 4 工具 + 懒提示段 + 两个内置游戏引擎（无 UI）。
  验收：Agent 在纯对话里完成一整局井字棋（工具日志可重放）。
- **P1 人类可玩**：客户端游戏分区 + GameSurface + 视图服务 + revision 轮询。验收：人类点击
  与 Agent 落子在同一局面交错，关浏览器重开局面无损。
- **P2 可导入**：installed 目录 + `POST games/install` + 烟测校验 + 面板导入入口与失败原因展示。
- **P3 可扩展**：`api.games.register` + orphaned 会话语义 + Mod 示例（examples/mods 增一个
  猜拳或剧本小游戏作参照实现）。

## 6. 风险与开放问题

- **引擎无沙箱**：导入的 `engine.mjs` 与 Mod 同信任级（进程内执行、可全盘 IO）。缓解：文档
  明示「只导入你信任的来源」+ engines 门控 + 安装路径可审计；真正的沙箱（worker/vm 隔离）
  列为后续课题——vm 无意义（逃逸容易），worker 隔离 IO 面需要宿主支持，v1 不做。
- **state 64KB/动作 4KB 上限**：对棋盘/卡牌足够，对超大规模模拟（如百万格棋盘）会被拒——
  如实报错，不静默截断。
- **双子段一致性**：game.json 与 engine.meta 冗余，运行时以 engine.meta 为准、清单不符时
  安装期警告（单一事实来源纪律：运行时注册表）。
- **多开对局**：一个聊天允许多会话并存；`game_state` 缺省取最近活跃——歧义时返回列表让
  Agent 用 sessionId 精确寻址。
- **开放问题**：① 人机混合多方（>2 人、观战位）v1 只做 min/max 声明不做 UI 特化；② 计时器/
  悔棋有重放日志支撑但 v1 不做；③ 聊天流内嵌局面快照（FrontendFrame 渲染每步棋盘进消息）
  是有吸引力的增强，待 P1 后评估；④ 清单/meta 双子段冗余的校验/生成小工具（§9 摩擦 4）；
  ⑤ 人类坐标约定标准化（§9 摩擦 5）。

## 7. 明确裁剪与否决项留档

1. **游戏跑浏览器 iframe、工具经轮询远程遥控 DOM**——否决。无 Node→客户端推送（刻意
   决策），工具延迟 ≥3s 且侧边栏关闭即瘫痪，Agent 无法无头对局；且 DOM 自动化对规则零
   保证（作弊/误触无合法性终审）。这是「权威状态在 Node」结论的反面。
2. **任意 HTML 游戏原样导入 + 点击注入**——否决，同上；改为定义公共标准让游戏**为标准而写**，
   「直接导入」的语义是「符合 dsh-soulmojito 游戏桥标准的游戏包直接导入」（与用户需求原文一致）。
3. **实时游戏**——v1 裁剪（`turnBased: true` 恒真）；实时需要推送通道与帧同步，与本插件
   「无 SSE」基线冲突。
4. **人类落子自动唤醒 AgentLoop**——初版延后（宿主无「游戏事件触发 agent 回合」seam，
   v1 骑聊天回合、面板提示用户发消息唤 AI）；**2026-10-14 修订推翻**（用户反馈）：
   不需要宿主新 seam——AgentLoop 的工具 Promise 本身就是挂起面，`game_wait` 让 agent
   在自己回合内阻塞等人类落子（`games-changed-listeners` 跨 bundle 唤醒），见 §4.2 与
   §10。旧「骑聊天回合」降级为模型提前结束回合时的兜底。
5. **给 games 骑全局 storeRevision**——否决。水位语义是资产目录摘要（store.ts 注释明示
   state.json 不参与），落子级频率会逼全面板重取 bootstrap；用 games 专属 revision 端点。
6. **Mod 静态文件服务（让 Mod 游戏带多文件资产）**——否决（v1）。维持 Mod 内联纪律
   （engine 对象 + view 字符串），不开新的磁盘服务面。
7. **WebSocket 推送**——否决（2026-10-13 用户问询补记）。三层：① **seam 级不通**：
   `ctx.webServer.register` 只暴露逐请求 `handler(req, res)`（`index.ts:656-689`，Node
   req/res 回调），WS 需要挂接 HTTP server 的 `'upgrade'` 事件做 socket 劫持，宿主无此
   面——2026-10-08 决策「DSH 宿主没有面向插件的服务端推送面」的源码级印证（浏览器侧
   同源可发 `new WebSocket()`，瓶颈纯在服务端 seam）。② **收益不匹配**：游戏的客户端→
   服务端方向已有 POST 正向通道，WS 独有的双向性无用武之地；延迟收益仅「看 AI 落子」
   从 ≤1s 轮询降到 ~即时，回合制下是锦上添花。③ **中间路径存在**：seam 允许长响应
   （生成路径即挂起 NDJSON 逐行 `res.write`，`main.js:2420-2432`），若 P1 后确需亚秒
   刷新，优先评估「对局事件挂起流」（单向下行、复用生成模式、零新基建）而非 WS。重评
   信号：宿主提供 upgrade/推送面，或出现实时游戏/多人观战需求。

## 8. 测试与验收（基线对账随实现提交）

- **契约一致性套件（标准即测试）**：通用 conformity 测试——任意游戏包过确定性/JSON-safe/
  合法性抛错/尺寸上限五关；内置两游戏与导入路径共用同一套件（标准不是文档是可执行断言）。
  「满盘和棋」无通用配方（见 §9 摩擦 1），由各游戏自带和棋测试数据。
- `sessions.spec`：开局/落子/终局/认输/重启续局（重开会话文件重建）/多会话寻址。
- 工具四件：bind 语义、非本方回合报错、describe 透传、`game_*` 种子对账。
- HTTP：action 合法性终审（伪造动作 400）、revision 便宜性（stat 不读内容）、view 服务的
  CSP/token/双源校验（负样本：错 token、跨会话 token）。
- gates：server-bundle（四工具名 + 路由 + 注册表 marker）、frontend-runtime（games 分区 +
  game-state/game-action 消息 marker + 1s 轮询）+ 各自负样本自测。
- 端到端：`pnpm run check` exit 0，README 测试基线对账。

## 9. 2026-10-13 补记：五子棋参照实现与标准修订（实弹检验）

首个标准游戏包落地：`packages/plugin/examples/games/dsh-soulmojito.gomoku/`
（`game.json` + `engine.mjs` 237 行 + `view.html` 402 行 + README），配套
`packages/plugin/tests/games-gomoku.spec.ts` 29 用例。**运行时（`src/games/`）尚未实现**，
本包不注册不装载，当前价值 = 标准的第一次可执行检验。测试基线 89 文件 1276 过 +1 跳 →
90 文件 1305 过 +1 跳（净增 29），`pnpm run check` exit 0。规则裁剪如实标注：自由五子棋
（≥5 连即胜含长连、无禁手）、resign 留给运行时。

实现中暴露的契约摩擦与处置（前两条已回写正文）：

1. **满盘和棋无通用配方**：设计时的直觉「棋盘格交错排布保证无五连」在自由规则下不成立
   ——棋盘格的对角线同色，扫描序第 61 手即黑胜（实测）。最终用 `(x+2y) mod 5 < 3` 基底
   （四方向步长 mod 5 均非零 ⇒ 任意连续 5 格恰 3 黑 2 白）翻 22 子构造 113/112 满盘和棋，
   冻结为测试数据且测试内自校验。§8 已注明 conformity 套件中和棋关由各游戏自带数据。
2. **下行载荷补 `summary`**：原 `view` 无 summary 字段，终局横幅文案每个视图要自行合成，
   丢失引擎措辞。已改（§3.3）。
3. **legalActions 语义修正**：原「合法动作（≤64）」双读冲突，改称**建议集**并显式声明
   不可作合法性门控（§3.2）；五子棋落地为：空盘只建议天元、中局按邻近度打分截断，
   applyAction 按全量规则终审、视图可点任意空点。
4. **清单/meta 双子段冗余**（7 字段逐字符两份，测试钉死逐字段相等）：维护成本已感知，
   列为开放问题——运行时落地时可给游戏作者一个清单校验/生成小工具，不进 v1。
5. **人类坐标约定未标准化**（列 A–O/行 1–15 只在 actionVocabulary 散文里）：v1 够用，
   游戏多了以后值得提炼为共享约定，列为开放问题。

**实施落点（同日 P0–P3 全量落地）**：`src/games/` 运行时 + HTTP 九路 + Agent 四工具 +
懒段 + 面板「游戏」分区 + Mod `api.games.register` + rps 猜松示例 + 六份 games-*.spec；
与本文的主要偏差（内置缩为井字棋单内置、v1 会话恒一人类一 Agent、game_state 缺省最近
活跃等八项）与已知边界（孤儿化不推进 revision、409 双载、首条下行时序、ASCII gate
marker）逐条留档于决策文档 2026-10-13-agent-game-bridge.md；测试基线
96 文件 1382 过 +1 跳。

## 10. 2026-10-14 补记：game_wait 阻塞等待与对局面 MVU 同位自动展示（用户反馈修订）

需求源：2026-10-14 用户对初版交互模型的修正——①游戏应**自动显示在与 MVU 状态同样
的位置**（而非藏在设置面板「游戏」分区里）；②Agent 应获得 **wait 工具**：用户完成
游戏操作后工具返回信息、Agent 自动进行下一步，**不中断、不需要用户发送消息触发**。

### 10.1 wait 工具（推翻 §7-4 的「宿主无 seam」结论）

初版把「人类落子唤醒 agent」判死在「宿主无游戏事件触发 agent 回合的 seam」上——那是
在**等宿主推事件进来**。修订把控制流反转：**agent 自己挂起等事件**。AgentTavern 会话
由宿主原生 AgentLoop 驱动，工具 `execute` 返回的 Promise 就是天然的挂起面（`exec.signal`
即用户停止生成的中止面）；人类落子走既有 HTTP 正向通道（`POST games/action/:id`），
服务层 `emitGamesChanged()`（`games-changed-listeners` globalThis 监听表）跨 bundle
唤醒等待中的工具——**零新宿主能力、零新网络面**。

- `game_wait(sessionId?, timeoutMs?)`：循环「读快照 → 判定 → 等信号」。唤醒信号三路：
  `onGamesChanged` 事件（主）+ 1s tick（兜底外部改动）+ `exec.signal`（中止）。
- 返回 `{status, sessionId, session, view, lastMove}`：`your-turn`（轮到 Agent，含人类
  刚落那手的 describe/summary 供叙述）/ `finished` / `orphaned` / `timeout`。**超时不是
  错误**——返回未变局面让模型自行再 wait（每次超时续等只花一次 LLM 轮次）；中止抛
  AbortError 语义（与其它工具 `throwIfAborted` 同款）。
- `timeoutMs` clamp 1000..900000、缺省 300000：下界让超时路径可测，上界防模型传天文
  数字把回合焊死。
- 教学三处：`game_start`/`game_move` 描述尾部 + order -63 懒段指引行（「落到人类回合
  立即调用 game_wait 阻塞等待（无需用户发消息）」）。
- 边界如实标注：宿主若对单次工具有更短的超时，wait 会被提前打断——那是宿主行为，
  插件无法也无需覆盖；等待期间会话保持 busy 是该交互模型的固有代价（用户要聊天可
  停止生成，局面不丢）。

### 10.2 对局面 MVU 同位自动展示

初版对局面只在设置面板「游戏」分区——用户要打开管理浮层才能下棋，与「和角色聊天
下棋」的沉浸流相悖。修订按 MVU 状态的既有三面同位补齐（`TavernMvuStatus` 的挂载
拓扑）：

- **ST**：`TavernGameBoard` 内联 `TavernMvuStatus` 之后（源顺序由 games-client.spec
  断言锁定）；未终局对局自动占位，无对局 null 不占位；终局结果卡只展示本挂载期间
  见证过的对局（重进会话不翻旧账）。
- **AgentTavern**：右栏 tab `tavern-games`（`tavern-mvu` 同款注册）；标题栏 watcher
  1s 盯 `games/revision`（stat-only 便宜端点、页面不可见停发），出现未终局对局即
  `openTab` 自动展开，每会话只展开一次（MVU `autoOpenedFor` 同款纪律）。
- 数据面抽 `useChatGameSessions` 共用（管理分区与对局面同源，避免两份轮询逻辑漂移）；
  i18n「发送任意消息唤起 AI」族文案全部改写为 wait 语义（games-client.spec 负样本
  锁死不回流）。
- **实弹修复（用户首测反馈：侧边栏 tab 渲染为空）**：首版把挂载加载效应留在
  GamesPanel 组件里，共用 hook 无加载——右栏 tab/ST 内联经 hook 消费时从未拉取
  `games/list`，恒渲染 null；且「无活跃会话不轮询」与「会话只能靠加载出现」互为
  鸡蛋（tab 已开、Agent 在别处开局时永远等不来）。修法：加载/错误态收进 hook
  自持（挂载/绑定变化各一次，games-client.spec 锁死）；轮询改两档（对局中 1s/
  守望 5s，基线跨档保留）；侧边栏空态给「让 AI 开一局」指引而非空白（内联变体
  维持无对局不占位）。
- **二次修订（用户二测反馈：侧边栏不自动刷新 + 标题栏入口 + 空态美化）**：
  ①自动刷新 RCA——水位基线在数据拉取之后才立，存在「数据已读、基线未立窗口
  内落子被吞」的漏更新（AI 在棋盘打开瞬间落子即停在上一个局面直到下一手）；
  修法为加载串行序「先 await 基线再拉数据」（多一次 stat-only 请求换无漏更新
  窗口）。②标题栏加与 MVU 同位同款的游戏入口（openGamesSurface，右栏 tab
  优先、旧宿主回落设置面板游戏分区；ST 走内联对局面不占标题栏）。③空态升级
  卡片（图标 + 标题 + 指引 + 「打开游戏面板」按钮；dt-game-board-empty 样式
  与 games.openPanel 键）。gates 实测坑留档：负样本 `badGamesList` 单次
  replace 会被链式基线 marker 里的同子串救活（marker 幸存不翻红），改全量替换。

### 10.3 测试与 gates

`games-tools.spec` +6（wait 五路：立即返回/阻塞唤醒/超时/中止/终局唤醒 + 无会话报文；
假服务补 emit 写穿以镜像真服务）；`agent-tavern-tools.spec` 名单锁 22→23；
`games-client.spec` 7→12（内联顺序/tab 注册/旧文案负样本 + hook 自持加载/
基线先读/标题栏入口三断言）。gates：agent-tavern-isolation
+`game_wait` marker 与专属负样本；frontend-runtime +5 marker（TavernGameBoard/
useChatGameSessions/TavernGamesSidebarTab/'tavern-games'/openTab）与四个负样本。
版本 0.5.1→0.6.0（对齐五子棋示例 engines `^0.6.0` 的门控预期）。测试基线对账见
决策文档补记。

## 11. 2026-10-14 补记：内置五子棋回归（§4.1 双内置）

用户需求「帮我新建一个五子棋游戏」按产品实况重新裁定 §4.1 原案：**五子棋以内置
回归**——开箱可玩（npm 包 files 不含 examples/，此前只有能访问仓库的人才能拿到
五子棋；实况：对局环境只有内置井字棋，§9 参照包从未被导入）。落法：
`src/games/builtin/gomoku.ts`（引擎与参照包逐条同款的自由规则；内联视图人类回合
才启用点击与建议点提示、无 token 静态预览局面）；同 id（`dsh-soulmojito.gomoku`）遮蔽
以磁盘导入副本为准并记 warning；版本 0.6.0→0.6.1 连带 story-clock 示例与
mod-api.md 的 engines 值同步（参照包 engines 维持 `^0.6.0`——0.6.x 全系含 0.6.1，
是更准也更宽的声明；games-import 的宿主版本改从 package.json 推导）。决策全文、
遮蔽语义、视图四态真机验收与边界见
[decisions/2026-10-14-gomoku-builtin.md](../../decisions/2026-10-14-gomoku-builtin.md)。

## 12. 2026-10-14 补记：游戏图标手柄化（§4.3 四处游戏面）

用户反馈「游戏的图标换成游戏相关的如手柄图标」：§4.3 原案里「游戏」分区沿用
`IconSparkle16`（与「总览」同款），看不出游戏语义。宿主 `ui-primitives@0.2.0-rc.2`
的图标清单**没有手柄类图形**（`IconPlayOutline*` 是「播放」、`IconGoalOutline*` 是
「目标」），而请求宿主不存在的图标名会被 bind 记进 `synthesized`、被
`client-vm-mount` 门禁拦下——故按宿主图标几何纪律（16 网格 / `fill:none` /
`stroke:currentColor` / 1px Regular 档描边）本地自绘 `IconGamepadOutline16`，
形态经 16px 真光栅候选比选（带握把机型在该尺寸糊掉，取「胶囊机身 + 十字键 +
两颗按钮」），并在**四处游戏面**同款落地：面板分区注册表、右栏 tab guide、
AgentTavern 标题栏入口、右栏空态卡。「总览」继续用 sparkle（两分区不再共用图标）。
决定全文、量测证据与边界见
[decisions/2026-10-14-panel-nav-fixed-brand-and-gamepad-icon.md](../../decisions/2026-10-14-panel-nav-fixed-brand-and-gamepad-icon.md)。

## 13. 2026-10-14 补记：内置中国象棋（§4.1 内置序列第三款）

用户需求「新建内置游戏 中国象棋」：按「内置 = 开箱可玩面」的既定裁定（§11）以内置
落地，装载形态与井字棋/五子棋同款——`src/games/builtin/xiangqi.ts`（静态 import 的
TS 引擎 + 内联 viewHtml，零文件依赖）。规则面 v1 明示：全部常规着法（蹩马腿/塞象眼/
炮架/九宫/过河）与将军检测（含将帅照面「白脸将」）、送将禁令、将死与困毙（双终局
判负——象棋困毙是胜负不是和棋）完整实现；长将/长捉/循环裁决与限着不实现（v1 无自动
和棋）。describe/events/summary 统一用**中文象棋记谱**（红汉字黑阿拉伯、进退平、
前/中/后消歧——Agent 叙述的自然语言面）。legalActions 语义与五子棋建议集不同：
完整性优先返回**全部合法着法**（初始 44 步，>64 时吃子优先截断——实战不可达），
视图据此只放行建议集内目标（象棋合法性是局部的，放开点击会大量撞 400）。版本
0.6.1→0.6.2 连带 story-clock 示例与 mod-api.md 的 engines 值同步。决策全文、记谱
设计、视图四态真机验收（含截图驱动修的两处图像缺陷）与边界见
[decisions/2026-10-14-xiangqi-builtin.md](../../decisions/2026-10-14-xiangqi-builtin.md)。


## 14. 2026-10-14 二次补记：工具面 token 经济修订——wait/move 只回更新，读取面独立（用户反馈）

需求源：2026-10-14 用户——「改进 game_wait 让它不再返回全部信息，而是返回更新的信息，
单独提供工具给 agent 读取游戏交互历史和当前游戏状态」；随后对首版修订的实弹输出追加
「还是复杂了」「game_move 也要改进」，并把总要求写死：**「game 系统应该尽可能考虑
token 经济性」**。诊断（§4.2 初版形态的实况）：会话快照在每个读写面都挂 `moves` 全量
动作日志 + 整盘 view——`game_wait`/`game_move` 每手回吐全量日志与棋盘，token 随对局
线性膨胀（用户实弹 4 手五子棋局面 ≈600 token，日志与棋盘占九成；30 手推算 ~2k+）；
且载荷里混着大量「模型已知/永不使用」的字段（players、动作词汇表、会话时钟、聊天
绑定、`orphaned:false`、`finished:false`、`winner:null`、move.at）——同一局面中间版
仍 526 字符（≈164 token），最终扁平版 99 字符（≈31 token），行动信息不足 15 token。

落法（契约层 + 服务层 + 工具投影层；client 零改动——前端从不消费 `moves`）：

- **快照头去日志**：`GameSessionSummary` 移除 `moves`，换 `moveCount`（总量锚）。日志
  本体仍完整落会话文件（可审计重放是八项表承诺，不变），读取只经新的有界窗口面
  `GameSessionStore.history(sessionId, {from?, limit?})`——`limit` 夹 [1, 200]（缺省 20），
  `from` 为窗口首条 0 基下标（缺省最近 limit 手起点、夹进 [0, moveCount]）。钳制权威在
  store；tool 层只做整数形态检查（agent bundle 不 import 会话运行时，见 handle.ts 纪律）。
- **工具载荷全部扁平最小化**（token 经济裁定的核心落点）：身份面只在 `game_list`/
  `game_start` 出现一次；回合载荷只带「下一步动作与叙述」所需；无嵌套 session/view 块、
  无 `orphaned:false`/`finished:false`/`winner:null` 之类零信息字段（缺席即默认）。
  - `game_start` → `{sessionId, gameName, players, turn, turnOwner}`——**不再回初始棋盘**
    （默认路径人类先手，下一手是 game_wait，棋盘此刻没人需要；需要时经 game_state 读）。
  - `game_state` → `{sessionId, gameName, turn, turnOwner, moveCount, finished,
    winner?, summary?, orphaned?, state, legal}`——局面面保留（落子决策的最小工作面）。
  - `game_history`（新工具）→ `{sessionId, gameName, moveCount, from, finished,
    winner?, summary?, moves:[{actor, action, describe}]}`——记录投影三字段，
    move.at/summary 留在盘上。
  - `game_move` → `{sessionId, describe, finished, turn?, turnOwner?, winner?, summary?}`
    ——只有叙述文案与「下一步给谁」；棋盘不回声。
  - `game_wait` → `{status, sessionId, newMoves, turn?, turnOwner?, winner?, summary?}`
    ——`newMoves` 是**等待期间到达的手**（唤醒场景即人类刚落那手；立即 your-turn（人类手
    在 wait 之前落地）时恒空——局面经 game_state、往手经 game_history 补齐）。等待循环
    改经 `history()` 读快照 + 增量（首读 limit 1 只立 moveCount 基线），顺带不再每拍
    重算 legalActions。终局/孤儿时轮次字段缺席（引擎 state.turn 停在最后一手，不读成
    下一手——模型以 finished/status 判定）。
- **角色归属随懒段常驻**：回合载荷不再带 players，懒段每会话行改为「你执 <agent 角色>，
  轮到 <角色>（归属）」——压缩/换上下文后不需工具补读。
- 教学三处同步（game_start/game_move/game_wait 描述、order -63 懒段）：「轮到你时先
  game_state 读局面、再 game_move 落子」「wait 只返回增量」「往手走 game_history」。

代价如实标注：常见回合从 2 次工具调用（game_move → game_wait）变为 3 次（+1 次 game_state
读局面；进程内文件读、非网络往返），换取每手载荷**不随对局长度增长**且身份/审计噪声清零
（开局省一张整盘棋盘、每手省 players/词汇表/时钟/日志，move 载荷从 ~180 token 降到
~25 token）。

测试与 gates：games-tools.spec 五工具→六工具 + 扁平载荷断言（move 无 view/无 session/
无日志、wait newMoves 三字段投影与四路状态、history 窗口/钳制/寻址、state 扁平面、
懒段「你执 <role>」）；games-service.spec 增 history 窗口 describe（缺省尾窗/分页/钳制/
越界；长日志 25 手经会话文件注入构造）；agent-tavern-tools/mount 名单 23→24；gates
agent-tavern-isolation marker 六名 + game_history 专属负样本。版本 0.6.2→0.6.3（补丁位）
连带 story-clock 示例与 mod-api.md 的 engines 值同步。决策全文见
[decisions/2026-10-14-games-delta-tools.md](../../decisions/2026-10-14-games-delta-tools.md)。

## 15. 2026-10-14 三次补记：人类落子自动续弈——Agent 没 wait 时的插件侧唤起（用户需求）

需求源：2026-10-14 用户——「当 agent 没有调用 wait 而是停止运行后，用户操作完游戏
由插件自动触发 agent 继续」。此前该场景的兜底是「懒段 order -63 常驻局面摘要 + 用户
发任意消息唤起」——用户要的是零消息自动续弈。§7-4 的原始论断（「宿主无游戏事件触发
agent 回合的 seam」）在 §10 被 wait 挂起面绕开（agent 自己等事件）；本次补上另一半：
**插件侧主动唤起**——宿主有 `ctx.agents.get(id)` + `Agent.followup(message)` 面
（agent-novel 调度驱动已全量使用），不需要新宿主能力。

落法（四层）：

- **等待登记（跨 bundle，src/games/handle.ts）**：`beginGameWait(sessionId)` /
  `gameWaiters(sessionId)`——game_wait（agent bundle）挂起时登记、finally 注销；
  index bundle 的人类落子入口据此判定「该手已由工具内唤醒覆盖」。没有它，等待中的
  回合结束后会多出一个陈旧通知回合（重复唤醒，token 与经济双重浪费）。
- **投递（src/games/wake.ts）**：`wakeAgentOnHumanMove`——反查该聊天的 AgentTavern
  绑定（index.ts 注入的 bindingOf 扫 sessionBindings，只认 agent-tavern 且非群聊）→
  `ctx.agents.get(agentId)` 取 live agent → `agent.followup(notice)`。通知是**插件
  来源**消息（`hostPluginMessageSource`：v4 宿主 producer-owned kind / v0-v3 分支；
  form 'notice'），绝不伪装用户消息——与 agent-novel 驱动通知同一机制与形状纪律。
  幂等 id `game-notice-<sessionId>-<moveCount>`；文本 token 经济：「自动游戏通知
  （非用户消息）：对手已在「<游戏>」棋盘落子，继续对局。sessionId: <id>」（终局
  变体带上结果与收尾指引）。
- **触发（src/games/service.ts）**：`humanAction` 成功出口回调 `onHumanAction`
  （index.ts 接线）；被拒动作（409）不回调；回调抛错只记日志（落子回执不受影响）。
- **降级（不投递即静默兜底）**：等待中 / 无绑定 / 群聊 / 非 agent-tavern / 冷会话
  （agent 不在注册表）/ followup 抛错——全部落回既有懒段 + 下次消息唤起路径，
  不重试（事件语义而非调度语义：一次人类动作一条通知，错过由兜底覆盖）。

边界如实标注：宿主对排队输入的处理（如用户停止生成时的 cancel 清队）可能丢弃已排队
的通知回合——下次人类落子/消息仍会补上；同一聊天多 AgentTavern 会话绑定时只唤起首个
（v1 边界：一个聊天一个对局一个会话，与工具面寻址假设一致）。

测试与 gates：新增 `games-autowake.spec.ts` 8 例（投递形状/等待中不重复/会话隔离/
逐级降级/抛错不外溢/终局文本/旧宿主 source 形状）；games-service.spec 增 onHumanAction
回调 describe；games-tools.spec 增等待登记的挂起/注销断言；gates server-bundle 增
`dsh-soulmojito:games-waiters` 与 `game-notice-` marker + 负样本。

## 16. 2026-10-14 四次补记：禁用投降 + 用户投降按钮 + 终局保留盘面（用户需求）

需求源（同日三条用户反馈）：①「添加禁用投降（显示在管理面板中）和用户投降按钮，
渲染到游戏显示区」；②「游戏结束时……应该显示游戏盘面，结束游戏很突兀」。

落法（四层）：

- **策略层（tavern-store state + service 门）**：新增 `gamesDisableResign`（默认
  false；面板「游戏」分区开关，state 路由接受、归一化容错）。服务层
  `assertResignAllowed` 在**两个动作入口**（人类棋盘 humanAction / Agent game_move）
  对 `{type:'resign'}` 一致拒绝（400 + 中文报文）——按钮隐藏只是 UI 面，服务端门
  才是权威（旧客户端/工具面都不能绕过）；策略逐次读 TavernStore 内存态，翻转即时
  生效、无缓存写穿。
- **语义层（人类出回合投降）**：`resign` 是会话级终止而非行棋动作——人类可在任意
  时刻投降（含 AI 回合，棋盘上的按钮随时可用），actor 重锚为人类角色、
  describe/winner 随之一致；Agent 的 resign 仍受回合纪律约束。形状校验（JSON 对象/
  type/尺寸）前移到回合判定之前（例外判定需要先知道 action.type，且畸形动作报
  invalid 比报 turn 更准确）。
- **UI 层（client，零新网络面）**：`GameSurface` 棋盘 iframe 之下新增投降按钮——
  两步点击确认（armed 态 4s 自动复位，防误触）、「禁用投降」开启时整体不渲染；
  上行复用与棋子同一条 `postAction` 路径（ref 持有最新闭包，message 效应不锁旧
  session 态）。按钮出现在全部三个对局面（ST 内联 / 面板会话卡 / 右栏 tab）——
  它们共用 GameSurface。
- **终局盘面（用户反馈 ② 的修正）**：终局不再只剩一行结果文案——`TavernGameBoard`
  与 `GamesPanel` 的 finished 分支同样渲染 GameSurface（视图自带终局覆盖层、点击已
  禁用），结果行在盘面之下。数据面配套：`useChatGameSessions` 的补拉过滤从「未终局」
  放宽为「未终局 **或本次挂载见证过的已终局**」（`sessionStatesRef` 见证集）——最后
  一手若由对方走出，旧的过滤会把它停在倒数第二手；挂载时已终局的旧对局不补拉
  （「不翻旧账」纪律不变）。

测试与 gates：games-service.spec 增「投降门与出回合投降」describe（四例：出回合投降
锚定/human 与 agent 的规则差异/门控两入口 + 翻转即时生效 + 普通动作不受影响/形状
校验前移）；`games-client.spec` 增投降与终局盘面 marker/双表 i18n/两处 GameSurface
同款断言 + 负样本；store.spec 默认值对账加 `gamesDisableResign`；gates server-bundle
增 `gamesDisableResign` + `assertResignAllowed` marker、frontend-runtime 增
`dt-game-actions`/`dt-game-resign-armed`/`gamesDisableResign`/见证集判据 marker 与
各自负样本。

## 17. 2026-10-14 五次补记：象棋将军提示层（用户需求）

需求源：2026-10-14 用户「象棋应该提供提示：如将军提示」（同日象棋实弹对局 g-f0249982
后的即时反馈）。诊断：v0.6.2 视图已有轻量将军标记（横幅后缀「· 将军！」+ 被将帅脉冲
圈），但后缀埋在「轮到你走子 · <往手摘要>」长行里、与摘要自带的「将军！」重复，人类
被将时也没有「怎么解」的指引——实弹对局中红方全程无被将提示（唯一的将军信号是终局
覆盖层）。

落法（纯视图层，单文件 `builtin/xiangqi.ts` 的 viewHtml；引擎 / 桥协议 / 工具面 /
client 零改动）：

- **警报横幅 `#banner.check`**：深红底 + 呼吸光晕动画（`dt-check-flash`），优先级
  `finished > check > 回合底色`；文案三语境（owner 反查——人类未必执红）——人类被将
  「将军！你（红方）被将军了——必须解将」、AI 被将「将军！黑方被将军——AI 正在解将…」、
  归属未知回落「将军！红方被将军」。check 态不拼往手摘要（避免双「将军！」），旧后缀
  式提示删除。
- **被将帅高亮**：既有脉冲圈之外加半透明红底晕 `.check-halo`（小尺寸面板可辨）。
- **底部行动指引**：人类被将给出可执行解将指路（移帅/仕、垫子、吃掉将军的子）；AI
  被将标注「正在解将」。

边界：不做棋力分析（不提示「有杀/最佳着法」，另立需求）；check 是瞬态呈现、解将即
消失；终局由覆盖层承担。测试与 gates：games-xiangqi.spec +1 用例（横幅/动画/光晕/
两语境/指引）；gates server-bundle 增 `#banner.check`/`check-halo` marker + 负样本；
headless Chrome 三态真机验收（人类被将 / AI 被将 / 对照）DOM 断言 + 截图。版本保持
0.6.3（并入在飞批次）。决策全文见
[decisions/2026-10-14-xiangqi-check-prompts.md](../../decisions/2026-10-14-xiangqi-check-prompts.md)。

## 18. 2026-10-14 六次补记：内置 21点（§4.1 内置序列第五款；“并行实现”）

需求源：2026-10-14 用户「并行实现新内置游戏21点」+ 同日中途改版「改成AI做庄」。
装载形态与既有一切内置同款（静态 import 的 TS 引擎 + viewHtml 字符串常量内联、
零文件依赖、随插件分发）；装载面零新增（game_* 六工具与面板「游戏」分区零改动
即见新游戏；client 零改动）。

**形态裁定（v2 最终面）**：roles `['player','dealer']`——人类缺省执 player、
Agent 缺省执 dealer（sessions.start 的 humanRole 缺省 roles[0]、game_start 的
role 缺省取另一方 →「AI 做庄」是开箱默认）。**庄家手由 Agent 真实来打**：庄家
回合轮到 Agent，逐张补牌、最后停牌；赌场家规由引擎强制执行（<17 只许补牌、
≥17 只许停牌——违规动作中文抛错）——规则公平性不打折（庄家自由决策会显著抬升
庄家优势，故家规做成引擎级非法动作闸），每张补牌都是 Agent 的一手调用与叙述
素材。玩家爆牌即结算（赌场同规：无人可比庄家不补牌）；玩家停牌时同手亮暗牌，
庄家随后按家规补至 ≥17 停；裁决：玩家爆→庄家胜、庄家爆→玩家胜、比点高者胜、
同点平局。v1 曾按「一人类一 Agent」双人对局硬裁剪落成「双方各执一手牌对赌、
庄家只是引擎机制」——用户中途裁定修此（庄家是本义、不是道具），v1 引擎/spec/
视图整体重写为 v2。

**暗牌公平性设计（两版共通的最关键一条，如实标注）**：桥契约里 state 对视图
（game-state 下行）与 Agent（game_state 工具）全明、无按角色脱敏面——落法：
**暗牌延迟决定**——玩家回合期庄家只有 1 张明牌（视图画装饰牌背），暗牌在玩家
停牌（或爆牌结算）那一刻才从牌靴游标续发并立即亮明；「信息不存在」是全明
state 下唯一防偷看手段，且揭晓时玩家已无决策可受影响，统计上与「先扣暗牌」
同为均匀未知分布。

**确定性**：`seed` 派生分块牌靴流（mulberry32 ⊕ 块序，Fisher-Yates，每块 52 张、
取之不尽——无重洗/耗尽边界）；createGame(options) 读 options.seed，缺省
node:crypto 随机整数（全文除该处外禁 Math.random/Date.now，spec 扫源码钉死）。
规则面 v1 裁剪：无下注/加倍/分牌/保险/天牌赔付（动作面只有 hit/stand；两张 21
只是点数 21）；玩家到 21 自动停牌（含初始天牌）；终局不变量 finished ⇒
hands.dealer.length ≥ 2（暗牌必已亮）。

**并行施工方式（本轮特有，如实留档）**：用户「并行实现」按两会话并行落地——引擎+
视图（agent A）与蓝军测试（agent B，独立于实现按同份契约施工，断言只锁不变式与
契约面、不镜像洗牌实现）并行；集成（registry 装载数组、games-builtin.spec 内置
数组断言、gates server-bundle 标记 + 负样本、版本连带）与全量验证由主线合并。
v1 轮对撞实录：两条独立路径在 4 处契约陷阱（软 21 `A+K` 摸 10 值牌仍是 21 自动
停牌而非爆牌；暗牌揭晓叙述合并规则；初始 21 自动停牌边界；describe 含「当前」）
上先分歧后收敛。v2 改版（用户「改成AI做庄」）同两 agent 按新契约重做一轮。

**同日并行第二 lane（军棋，兄弟会话）**：两 lane 在 registry 装载数组、
games-builtin.spec 内置数组断言、gates server-bundle 标记块三处共享文件以合并
纪律共存（增量编辑、互不回滚）；版本连带统一 0.6.4。

测试与 gates：新增 tests/games-blackjack.spec.ts（清单/形状/视图自包含与管线
（含终局结果条 result-strip 锚点）/createGame 两开局分支/玩家回合语义（安全 hit、
21 自动停牌、爆牌即结算）/庄家回合语义（家规建议集、补牌、爆牌结算、三态裁决）/
终局不变量（暗牌必亮）/家规非法动作/非法动作全家族/确定性/建议集/describe/
源码扫描/尺寸/烟测五关/真实 service 端到端）；games-builtin.spec 内置数组断言
扩至五内置；gates server-bundle 增 `dsh-soulmojito.blackjack` marker +
`blackjack-removed` 负样本。视图另经 headless Chrome 四态截图验收（预览/玩家
回合/庄家回合/终局）——**截图驱动两级修订**：终局呈现从「覆盖层压暗」（.74
渗色 → 压 .92 仍有残影）改为**盘面之下的 in-flow 结果条**（盘面完整保留——
0.6.3「结束时应该显示游戏盘面」语义，文字零叠压）。决策全文见
[decisions/2026-10-14-blackjack-builtin.md](../../decisions/2026-10-14-blackjack-builtin.md)。

## 19. 2026-10-15 七次补记：内置记忆翻牌对战（§4.1 内置序列第六款）

需求源：2026-10-15 用户「新建内置游戏 记忆翻牌对战 轮流翻牌，配对成功得分」。
装载形态与既有一切内置同款（静态 import 的 TS 引擎 + viewHtml 字符串常量内联、
零文件依赖、随插件分发）；装载面零新增（`game_*` 六工具与面板「游戏」分区零
改动即见新游戏；client 零改动）。

**规则面（v1 最终面）**：4×4 = 16 张牌、8 种图案各两张（单字汉字：月/星/花/
雷/鱼/蝶/山/水）；牌位下标行主序 0-15（列 A-D、行 1-4）。**一手 = 一次动作**
`{type:'flip', a, b}` 同手结算（原子性、无「翻开第一张等第二张」的半手中间态
——与 §14 token 经济裁定一致：每手一次 game_move、行动载荷不随对局膨胀）；
配对成功 = 得 1 分 + 两张定格 + **同一方继续翻**（经典 Concentration：配对 =
得分 + 保留回合；「轮流」体现在失配换手——如需严格轮流变体应另立游戏 id 或
单点修改）；失配 = 两张翻回 + 换对方；8 对配完比总分（高者胜、同分平局
winner null）。裁剪如实：无计时/无悔棋/无多副加盘。

**隐藏信息设计（本款最关键一条）**：桥契约 state 对视图/Agent 全明、无按角色
投影通道——未翻开的牌面**不进 state**（只物化已被双方看见的事实：已配对定格面
与 lastFlip 最近一手），任意牌位图案由 seed 确定性派生、翻牌那刻才物化；与
21 点牌靴同款信任模型（state 带 seed 与派生纪律、不是答案本身）。「防偷看
不变式」由 games-memory.spec 用例钉死（开局 8 面不在 state 序列化文本内；失配
一手后仅该手两面经 lastFlip 物化、其余仍不出现）。记忆面公平性如实：Agent 可
经 game_history 复读往手 describe（审计日志是桥的既定设计），视图以「上一手」
横幅与翻回预览辅助人类。

**建议集语义**：任意两张未翻开的牌（图案未知时任意对等价）；开局 C(16,2)=120
超 §3.2 的 64 上限——按行主序截断（前 15 对即 (0,j) 全跨度，任意截断下每个
未翻开牌位都被覆盖）；applyAction 按全量规则终审任意动作。

**截图驱动修订（如实留档）**：① 初版牌面用表情符号（🌙⭐🍀⚡…）——真机验收
（headless Chromium 150、仅 CJK 字体环境）全量渲染为豆腐块（仅 ⚡ 落在字体
覆盖内）；修订为**单字汉字**（与 UI 同一 CJK 字体上下文、渲染有保证；象棋/
军棋汉字棋子先例），spec 的「布局只从引擎输出反推」写法使修订零测试改动。
② 人类回合横幅文案对齐既有范式（「轮到你翻开两张牌」——黑杰克「轮到你行动」
同款），由真机断言首轮揪出。

测试与 gates：新增 tests/games-memory.spec.ts 33 项（清单/形状/视图自包含与
view 管线/静态锚点/createGame/布局不定式（8 图案各恰两张，只经 summary 输出
反推）/配对与失配语义/终局两态（全知 8–0 与手工 4–3→4–4 平局）/防偷看不变式/
非法动作全家族/确定性/建议集（120→64 截断覆盖全牌位、建议集外仍可执行）/
describe（含坐标引号串容错）/源码扫描/尺寸/烟测五关/真实 service 端到端「记忆
机器人」——只用 describe 观察到的牌面决策、人机双路径交替翻完全盘并与终局
盘面逐张对账）；games-builtin.spec 与 games-xiangqi.spec 内置数组断言扩至六
内置；gates server-bundle 增 `dsh-soulmojito.memory-match` marker + `memory-removed`
负样本。真机验收 28 项断言（预览/人类回合两段点击上行捕获与发送锁/翻回预览
动画 1.4s 退场/终局结果条与全盘定格/人类执蓝坐席反查）+ 截图 ×4。版本
0.6.4→0.6.5（补丁位）连带 story-clock 示例与 mod-api.md 的 engines 值同步。
决策全文见
[decisions/2026-10-15-memory-match-builtin.md](../../decisions/2026-10-15-memory-match-builtin.md)。

## 20. 2026-10-15 八次补记：内置大富翁（§4.1 内置序列第七款）

需求源：2026-10-15 用户「实现内置游戏 大富翁」（在独立 worktree 落地——main 上
有并行 agent 在跑，工作区隔离是需求的一部分）。与同日 lane「内置记忆翻牌对战」
合并后，本款为 §4.1 内置序列**第七款**（用户 2026-10-15 裁定：记忆翻牌第六款、
大富翁第七款；两 lane 共用一次 0.6.4→0.6.5 升版）。装载形态与既有一切内置同款
（静态 import 的 TS 引擎 + viewHtml 字符串常量内联、零文件依赖、随插件分发）；
装载面零新增（`game_*` 六工具与面板「游戏」分区零改动即见新游戏；client 零改动）。

**形态裁定（v1）**：双人环线经营——roles `['red','blue']`，人类缺省执 red、
Agent 缺省执 blue。棋盘 24 格（7×7 外圈）：起点 1 / 地产 14（地价 100-750）/
机会 4 / 税局 2 / 派出所 1 / 免费停车 1 / 年度分红 1；1d6 掷骰前进、经过或停留
起点领 200；停留无人地产可购买、自有地产可加盖（最高 3 级、每级=地价一半）、
对手地产付租（地价 × 30%/70%/140%）；机会 12 张卡（现金/移动/前往起点/进派出所/
向对手支付——移动卡落地照常结算但不连锁抽卡）；派出所暂停一次行动；任何应付
不足即破产（剩余现金归对手）；每人 16 回合上限兜底按净值（现金+地价+已付加盖费）
比高。**信息面（与同批记忆翻牌 lane 对照，如实标注）**：大富翁棋盘类信息天然
全明——桥契约的「state 对视图/Agent 全量下发、无按角色脱敏」在本款不构成公平性
问题（记忆翻牌用「未翻开牌面不进 state」、21 点用「暗牌延迟决定」——本款无需
任何隐藏信息设计，这是游戏类型差异而非实现取舍）。

**确定性**：seed 派生双流——骰子流（第 n 掷 = mulberry32(seed⊕n) 取 1d6）与
机会牌洗序（Fisher-Yates 进 `state.deck`，`deckIndex` 越尾取模循环）；
`createGame(options)` 读 `options.seed`，缺省 node:crypto 随机整数（全文除该处外
禁 Math.random/Date.now，spec 扫源码钉死）；探针取证：seed 7 前六掷 =
1,4,4,5,1,5（受控用例据此构造）、seed 1 牌序进视图静态预览局面逐字段对账。

**平衡面（调参盲测，如实留档）**：以真实引擎跑 300 局 × 3 策略（全买全盖 /
留现金稳健 / 50% 随机）——最终参数（起步 1500、系数 30/70/140%、上限 16）下破产
率 44%/30%/14%、平均 26-29 次掷骰、先手胜率 51%/52%/51%；更早的「2000 资金 +
20 回合」版平均 33-37 次掷骰（被动打法必打满 40 掷）、对局过长，被否决。

**规则可达性自纠（实现期两条死规则的收敛，如实留档）**：初版卡组下「机会→机会
连锁封顶」与「机会移动不发薪水」两条规则**没有任何可达路径**（没有机会格能因
移动卡落到另一机会格；移动卡最远只到 22、无一跨起点）——把一张卡改为「前进
4 格」（14→18 连锁可达）、一张改为「后退 3 格」（2→23 后退跨起点可达）后两条
规则可测，spec 各自钉死。

测试与 gates：新增 tests/games-monopoly.spec.ts 64 项（清单/形状/视图自包含与
管线（含预览局面与引擎 createGame({seed:1}) 逐字段防漂移、窄屏棋盘正方形静态
锚点）/棋盘与卡表自检/开局契约/掷骰探针与受控落点/购买·加盖·收租·破产/决定窗
阶段闸/税局·分红·停车·派出所/机会卡全家族（含连锁抑制与牌堆循环）/回合与终局
（破产与净值两途）/建议集/describe/确定性整局重放/尺寸/非法动作全家族/DOM 垫片
视图行为（按钮随 legal 收缩、棋盘归属渲染、终局结果条、坐席 owner 反查）/真实
service 端到端）；games-builtin.spec 内置数组断言扩至七内置 + 大富翁烟测；
games-xiangqi.spec 同款数组断言同步；gates server-bundle 增 `dsh-soulmojito.monopoly`
marker + `monopoly-removed` 负样本。视图另经 headless Chromium（CDP、生产消息
路径）六态验收——**截图驱动修订一处**：390×844 下 grid 行被格子 min-content
顶开（board 370×452 失去正方形），修复为 `.tile` 显式 `min-height:0` + 480px
窄屏收敛，复测 370×370。决策全文见
[decisions/2026-10-15-monopoly-builtin.md](../../decisions/2026-10-15-monopoly-builtin.md)。

## 21. 2026-10-15 九次补记：自动续弈两道防重闸——回合判定与运行中判定（竞态修复）

需求源：2026-10-15 用户——「修复大富翁游戏下 自动游戏通知（非用户消息）：对手已在
「大富翁」棋盘落子，继续对局。sessionId: g-60bfb716 异常触发的问题，agent 明明还在
循环输出中」。§15 的投递实现只带「game_wait 挂起中不投递」一条防重判据。

**真机对账（g-60bfb716，宿主会话 2026-10-15 07:51–08:00，事件级逐帧）**：

- 人类（红）回合几乎全部是「roll → 决定窗 → buy/build/pass」两次动作（会话 moves
  逐条可查：07:53:22 roll 出「故宫」可购买 → 07:53:41 buy；07:58:31 roll 出可加盖
  → 07:58:36 build；……）。
- 该段共发出 9 条通知（id 尾号 6/13/20/21/26/29/32/35/44 = 投递时的 moveCount），
  其中 **5 条（-6/-13/-20/-32/-35）对应 roll 命中决定窗的动作**——该手落地时
  `state.turn` 仍是人类（`phase='decide'`），「对手已落子，继续对局」是假陈述
  （引擎 actor===turn 闸必拒 Agent 落子；同一日志里 Agent 收到这类通知后的下一步
  只能是 game_state/game_wait，无法行动）。其余 4 条为该手真正交出回合的合法通知。
- 9 条通知**全部**以宿主 `agent/inbox/spliced`（`target:"next-turn"`）splice 进
  **尚未结束的 turn 3**（07:51:19 起、71 个 step，直至会话片段末尾未 end）——第一
  条 -6 距人类 roll 仅 9ms（07:53:22.996）。这正是用户观察到的「agent 还在循环输出
  中，通知异常触发」；被 game_wait 挂起吸收的手（如 07:53:41 的 buy）天然不投递，
  与 §15 防重完全一致。

**根因（RCA）**：§15 的语义锚是「Agent 没调 game_wait 就**结束回合**后」——实现只
检查了「是否正在 wait」，从未检查 ①该手是否真的把回合交到 Agent 手上；②Agent 是否
已经结束回合。于是「单回合多动作」玩法（大富翁决定窗 / 21 点连续 hit / 记忆翻牌配对
成功保留回合）的中途动作会提前唤醒，运行中的回合也会被 splice 成回合结束后的陈旧
通知回合。

**落法（src/games/wake.ts 单文件两点；service/index/工具面/client 零改动）**：

- `turnReachedAgent(session)`：终局恒真（收尾叙述，含人类投降与人类动作终结对局）；
  否则按 `players` 反查 `turn` 的 owner === 'agent'；`turn === ''`（不可判定）按不
  投递降级。不满足即在查绑定前短路（零 store 读）。
- `agentTurnRunning(agent)`：live agent `status === 'running'` 不投递——运行中的回合
  经自己的 game_wait/game_state 读面吸收该手；**刻意不做** whenIdle 等待投递（本
  函数在人类落子 HTTP 回执路径上被 await，等待会卡住棋盘回执；「等空闲再投递」也
  会回到陈旧回合问题——与 agent-novel 驱动的 whenIdle 等待刻意不同，那边是调度
  语义、不在回执路径上）。status 缺失/未知（旧宿主形状）逐属性降级为不拦。
- 通知 id 语义更新为「一次**交出回合的**人类动作恰一条」。

**边界（如实标注）**：Agent 正在运行的回合若恰逢人类极快交回合（该手未被吸收），
本闸不投递——由该回合自身的读面吸收；未吸收即回落既有兜底（懒段 order -63 常驻
摘要 + 下次任一消息唤起），不重试（事件语义不变）。

测试与 gates：games-autowake.spec +5 例（回合未交出与交回两态 / 终局不受回合闸限制 /
turn 不可判定 / 运行中与回 idle / status 缺失与未知不误杀）；gates server-bundle 增
`function turnReachedAgent(` 与 `function agentTurnRunning(` 两 marker + 各自负样本
自证。决策全文见
[decisions/2026-10-15-games-wake-turn-gates.md](../../decisions/2026-10-15-games-wake-turn-gates.md)。

## 22. 2026-10-16 十次补记：内置地牢爬行——品类扩展的第一款（Roguelike / Agent 当地下城主）

需求源：2026-10-16 用户——「游戏服务有没有可能扩展成支持 Roguelike 或者 RPG 的模式，
当前的小游戏有一些单调」，当日追加「做内置包地牢爬行」。前置是一轮**品类可行性评估**
（当日对话留档于决策文档首节）：桥契约约束的是形态（回合制、JSON state、确定性纯函数
引擎）而非品类；评估识别的三条硬边界——①会话恒「一人类一 Agent」（sessions.start 拒
`players.max !== 2`）、②state 全明无按角色投影通道、③§21 回合闸在 turn 停留人类时不
投递——本款全部转为设计语言而非核心改动。

**形态（`dsh-soulmojito.dungeon-crawl`，roles `['hero','world']`）**：人类执探索者、
Agent 执地下城主（DM 真实来打怪物回合：attack/heavy/defend 三择，21 点「AI 做庄」
同纪律）。12×12 网格 × 3 层醉汉游走凿洞（连通性由构造保证），英雄 4 向探索（切比雪夫
≤2 揭示）、拾取/陷阱自动结算、踏入活怪格遭遇（怪先手）后逐手交替，站石阶下楼（楼梯
坍塌、揭示层弃置——state 尺寸纪律的品类化落法，三层满探索实测 <1KB），3 层石阶炎魔
君王斩杀即通关。

**迷雾 = 延迟决定的三重化**（21 点暗牌与 §19 记忆翻牌「未翻开牌面不进 state」的
Roguelike 推广）：①岩壁布局由 `carveFloor(seed, depth)` 纯函数随时重算、**永不进
state**；②armed 陷阱由坐标 hash 判定、踏上才结算落 `trapSprung`（已揭示格无任何
痕迹）；③怪物/物品在揭示半径扫过时才从纯函数快照进 state——「程序化世界按需显影」，
Agent 读 game_state 也只能看到英雄走过的世界。

**节奏（引擎即节奏作者，§21 语义的对齐）**：探索动作全在英雄手内结算、turn 恒留
hero——**纯探索零 Agent 调用**（token 经济）；只有接战才把回合交给 world，§21 回合闸
恰在遭遇那一手投递真通知。平衡盲测（30 seed × 2 DM 风格）：仁慈 DM（恒 attack）通关
率 20/30、凶狠 DM（恒 heavy）11/30——贪心直奔脚本约五成，人类带探索与绕行显著更高，
死亡仍是被叙事的正当结局（seed 1 阵亡路径被端到端锁定）。

落法与验证：`builtin/dungeon-crawl.ts` 单文件（引擎 + 内联视图 + dungeonProbe 测试
探针；**预览局面由引擎 `createGame({seed:1})` 模块期实时生成注入**，与开局态零漂移）、
registry 装载数组第八项、gates server-bundle 增 id 字面量标记；games-dungeon-crawl.spec
39 项 + games-builtin.spec 内置数组/烟测 +1 项；sessions/service/工具面/client 零改动。
决策全文（八项表/规则裁剪/盲测数据/确定性双流/边界——怪物静态、DM 纯洁性不设防、
平衡未经人类实测）见
[decisions/2026-10-16-dungeon-crawl-builtin.md](../../decisions/2026-10-16-dungeon-crawl-builtin.md)。

## 23. 2026-10-16 十一次补记：地牢爬行视图反馈层——事件提示栈、飘字伤害与 PC 键盘

需求源：2026-10-16 用户——「攻击等交互事件应该弹出显眼的提示，在 PC 上支持 WASD
和方向键以及 JKL 绑定操作」。纯视图层单文件（引擎/桥协议/sessions 零改动，§17 象棋
将军提示层同款纪律）：①事件提示栈（dc-toast-stack）——每次局面真变化把该手 summary
弹提示（地图内浮层、底部锚定——三次位置迭代终态：初版顶部浮层挡画面 → 文档流位致操作栏抖动 → 底部锚定浮层零布局位移且入口区无遮挡），遭遇/陷阱/倒下 danger、通关 finale（通关优先于倒下——胜利 summary 两词兼有）、
至多 3 条、2.8s 淡出，指纹差分保证 1s 轮询重复下发与首帧不弹；②飘字伤害
（dc-float-num）——HP 差分驱动，英雄受击红/怪物受创橙/治疗绿/击杀 💀 按格位上浮；
③PC 键盘——WASD/方向键移动、J/K/L = 攻击/喝药/下楼，与按钮共用同一合法面（按钮
disabled 即按键静默，键盘不可越过回合闸），修饰键组合不劫持。测试 +6（DOM 垫片真跑
内联脚本，引擎真实载荷序列断言弹与不弹）；gates server-bundle 增两 marker + 负样本
自证。实现期自纠两笔（toastClassOf 分级顺序 / 裸 parent.postMessage 垫片不可注入）
与全文见
[decisions/2026-10-16-dungeon-crawl-builtin.md](../../decisions/2026-10-16-dungeon-crawl-builtin.md) 补记节。


## 24. 2026-10-16 十二次补记：game_wait_full（带棋盘视图的等待变体）与地牢 Boss 唯一化（实弹反馈）

两笔同日实弹反馈修订：

**game_wait_full（工具面第七件）**。需求源：用户观察真机会话（2026-10-14@20h28m）
「game_wait 后面又接查看状态，工具调用偏多——wait 返回的数据可能不太合理」，
并裁定方向「game_wait 在更轻量的游戏上表现更好，模型不会调状态，新增个带
状态返回的」。根因在 §14 契约：wait 只回等待期增量，重棋局上 describe 不足以
决策、模型必补 game_state（轻量局上极简 wait 已是最优）。落法：**不动
game_wait**，新增 `game_wait_full`——同款阻塞等待（等待登记/唤醒/超时/中止
全同），`your-turn`/`finished` 时返回附带 `view`（game_state 同款五字段载荷，
state + turn + legal + finished + summary），timeout/orphaned 不带；wait 描述与
懒段指引交叉引导按局选工具。联动：BUILTIN_TOOL_NAMES_SEED 第七名、gates
agent-tavern-isolation 工具名标记组、roster/mount 计数测试。games-tools.spec
+4（四路返回面）；agent bundle 单文件 + 三处联动，sessions/service/index/client
零改动。决策全文（含「参数式开关被否」的取舍、token 经济对账、view 读取窗口
边界，及同日实弹修复——objectOutput 第二参是可选键表而非必填表，view 未进
可选表导致 timeout 路径被宿主 schema 校验拒收，已修并新增 expectConformsToSchema
按声明 schema 验收工具返回的测试缺口）见
[decisions/2026-10-16-games-wait-full.md](../../decisions/2026-10-16-games-wait-full.md)。

**地牢 Boss 唯一化（引擎单点修复）**。需求源：用户真机观察到多个炎魔君王
「Boss 应该只能被生成一次」。根因：revealAround 初版把第 3 层**所有怪物格**
放成 Boss（石阶上反而没有）——满层君主且杀任意一只即通关。修复：Boss 放置
改为 `isStairs && depth === 3` 独立分支——恰一只、只在最深层石阶格；e2e 通关
用例加强为「走到石阶邻格取证 Boss 唯一性（BFS 路径避开石阶格）再踏入遭遇」
（原用例为错因通过——杀的是路径上的假 Boss）。见
[decisions/2026-10-16-dungeon-crawl-builtin.md](../../decisions/2026-10-16-dungeon-crawl-builtin.md) 四次迭代节。

## 25. 2026-10-17 十三次补记：内置中国跳棋（§4.1 内置序列第九款）

需求源：2026-10-17 用户——「新建一个内置游戏 跳棋」，确认品类为**中国跳棋**
（经典六角星弹珠跳棋，非国际跳棋）。本款延续「棋盘类恒双人对抗」的既有全部
形态：核心三件套（sessions/service/工具面/client）**零改动**，单文件装载
（引擎 + 内联视图 + 几何探针）。

**盘面（第一性几何）**：标准 121 洞六角星，以立方坐标 (q, r, s)（s = -q - r）
刻画为**两道大三角形的并集** { q,r,s ≥ -4 } ∪ { q,r,s ≤ 4 }——各 91 洞、交叠
六边形 61 洞、并集恰 121 洞，自动给出标准 17 行与行洞数
1,2,3,4,13,12,11,10,9,10,11,12,13,4,3,2,1。顶营 = 行 1-4、底营 = 行 14-17
（各 10 洞）。渲染 pointy-top 六边形（x = √3·(q + r/2)、y = 1.5·r），**布局表
由引擎模块期注入视图**（CC_LAYOUT——地牢爬行「预览局面引擎实时生成」同款
纪律的布局化；预览局面同款模块期实时生成）。

**规则面 v1**：红十子起于顶营、蓝十子起于底营，红先；每回合走到相邻空位或
跳过紧邻一颗弹珠（不分敌我）落于正后方空位——可连跳、拐弯自由、**同一手不
重复落点**（含不得落回起点，BFS visited 起手含起点硬保证防回环）；无吃子；
先把自己十颗全部搬进对方营盘者胜；对方无任何合法着法（困毙）同判本方胜
（军棋/象棋同款裁决）。坐标 = 0 基 [行, 列]、叙述用 1 基「行-列」名（「红方
4-1 走到 5-5」「红方 1-1 跳到 5-7（连跳 3 步）」）；建议集 ≤64 按「洞号升序 ×
步先跳后」的确定主序截断（真实 20 子局面实测上限约 60，截断通道由 12 子
构造夹具锁定），不是合法性依据。**本款零随机**——createGame 是常量纯函数，
不需要 seed。

**困毙可达性（如实留档）**：红方被全封锁的理论下界是 11 颗蓝子（十子满营时
仅突围面就有 5 个步位 + 6 个落点），大于蓝方 10 子——真实可达性未证；判定
保留为总函数，由 spec 的构造性夹具锁定。

**落法与验证**：`builtin/chinese-checkers.ts` 单文件（引擎 + 内联视图 +
chineseCheckersProbe 几何探针）；registry 装载数组第九项；gates server-bundle
增 id 字面量标记 + 负样本自证；games-chinese-checkers.spec 39 项（几何探针/
连跳与不重复落点/构造性困毙夹具/64 截断主序/引擎级冲家机器人整局收官/真实
服务收官双向/视图 DOM 垫片两段式点选）+ games-builtin.spec 内置数组与烟测
+1 项；headless Chromium 150 真机双档 18 项断言（420/360 视口、两段式点选
上行、跨回合横幅与 lastMove 金框、窄屏零溢出、零 console 错误）+ 截图。决策
全文（八项表/几何第一性/规则裁剪/困毙论证/机器人 e2e 家位跟踪两代自纠
留档/边界）见
[decisions/2026-10-17-chinese-checkers-builtin.md](../../decisions/2026-10-17-chinese-checkers-builtin.md)。

## 26. 2026-10-17 十四次补记：面板游戏包导入（zip 上传 + git 安装）与制作指南

**需求源**：用户实报——管理面板「游戏」页没有上传按钮，文档也没有如何制作符合标准的
游戏包。前者是 §4.5 / P2「面板导入入口与失败原因展示」的落地欠账（此前只有服务端
`POST games/install`，客户端从未接线；2026-10-13 决策与客户端注释均声称存在）；后者是
面向游戏包作者的文档缺口（§3 是设计契约、mod-api §18 只覆盖 Mod 内联注册）。

**§4.5 修订（传输层，不改标准）**：`POST games/install` 在 `{ path }` / `{ url }` 之外新增
`{ zipBase64 }`——zip 只是传输形态，解包（tavern-format `unzipArchive`，fflate 既有依赖）
后落临时目录，立即复用 `installFromPath` 的全量校验与 `installed/<id>/` 落地，因此标准
三件套、清单/引擎/烟测纪律与 `engine.meta` 权威全部不变。新增纪律（防滥用与 zip-slip）：
条目 ≤64、单文件 ≤2MB、解包总量 ≤4MB；`__MACOSX/`、`.DS_Store` 跳过；`..`/绝对路径拒绝；
单层包装目录自动下潜一层；面板 5MB 文件预检 + 服务端 8MB 正文上限。导入失败统一
`invalid` 400（用户输入类），消息原文透传给面板；导入成功但包 broken 仍按目录导入语义
「已导入 + broken reason」双面展示。

**面板入口**：「游戏」分区新增导入带——zip 文件上传 + git URL 安装两条路径共用强制覆盖
勾选与状态行（进度/成功/失败）；成功后重拉清单，新游戏立即出现在开局列表（与既有
`useChatGameSessions` 数据面同源，无新轮询）。

**文档**：新增 [`docs/games/game-package.md`](../games/game-package.md)（面向作者的三件套
规范、manifest 字段表、引擎契约与烟测五关、视图桥两条消息 + 最小骨架、四种导入方式、
zip 上限、broken reason 排错表、参照实现索引）。

**顺带修复**：GamesPanel 的 `loadList` 解构漏项（存量 bug，点「开局」抛
`loadList is not defined`，对局实际已开但列表不刷新）——纳入解构并由客户端源检查锁定。

**验证**：gates server-bundle +3 markers/3 负样本、frontend-runtime +7 markers/7 负样本；
`pnpm run check` 107 文件 1795 过 +1 跳（+6 用例），16 gates 全 PASS。决策全文
（八项表/偏差/边界/测试对账）见
[decisions/2026-10-17-games-panel-import.md](../../decisions/2026-10-17-games-panel-import.md)。
