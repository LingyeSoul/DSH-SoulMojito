# 游戏工具面 token 经济修订：wait/move 只回更新，读取面独立（提案 0018 §4.2/§14）

> 日期：2026-10-14。需求源：用户——「改进 game_wait 让它不再返回全部信息，而是返回
> 更新的信息，单独提供工具给 agent 读取游戏交互历史和当前游戏状态」；随后对首版修订
> 的实弹输出（game_move 仍回吐含 players/词汇表/时钟的会话块）追加「还是复杂了」
> 「game_move 也要改进」，并把总要求写死：**「game 系统应该尽可能考虑 token 经济性」**。
> 设计契约与先行件：[提案 0018](../docs/proposals/0018-agent-game-bridge.md)
> （§4.2 工具面、§10 的 wait 修订、本次新增 §14 补记）、
> [决策 2026-10-13](2026-10-13-agent-game-bridge.md)（工具面初版落地）。本文记录
> 诊断、落法、代价与否决项。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 回答 |
|---|---|
| 所有者 | `src/games/sessions.ts`（摘要与日志窗口的单一 owner）+ `src/games/service.ts`（history 透出）+ `agent-tavern/agent.ts`（六工具面、载荷投影助手与懒段）——四条消费链路同属本特性 |
| 唯一事实来源 | 动作日志仍以会话文件 `games/sessions/*.json` 的 `moves` 为准（本条不变，只改读取面）；工具可见形态 = 会话摘要（快照头）+ `history()` 窗口 + 工具层投影 |
| 持久态及理由 | 零新增持久态——快照瘦身与载荷投影都是读取层改动，日志完整落盘的可审计承诺原样保留 |
| 临时态 | 零新增（wait 循环的 moveCount 基线是循环内局部量，每次调用重建） |
| 外部依赖 | 零新增：复用既有 tool()/tool-args、globalThis 句柄 seam、onGamesChanged 唤醒链 |
| 注册入口 | 新工具 `game_history` 进 `createTools()` + `BUILTIN_TOOL_NAMES_SEED`（23→24）；gates agent-tavern-isolation marker 六名 |
| 删除路径 | 删 game_history 注册块 + 种子名 + gates marker/负样本 + games-tools.spec 的 history describe；投影助手（turnBrief/terminalBrief/moveBrief）与 `history()` 随工具面一处删（无数据迁移，日志本就在盘上） |
| 兼容对象 | 会话文件格式零变化（旧会话直接可读）；HTTP 面（list/state/action）随摘要自动瘦身——前端从不消费 `moves`，games-client 断言零改动；Mod API v1 零变化 |

## 诊断（为什么「全部信息」是问题）

初版每个读写面都返回同一份 `GameSessionSummary`（挂 `moves` 全量日志）+ 整盘 `view`。
两轮实弹反馈把它拆开看：

1. **随对局线性膨胀**：`game_wait`/`game_move` 每手回吐全量日志——30 手五子棋每手
   2k+ token，100 手对局每手是第 1 手的数倍。
2. **零信息字段**：即便砍掉日志，会话块里的 players（静态映射）、动作词汇表（懒段已
   常驻）、会话时钟、聊天绑定（`chat.character/chatId`）、`orphaned:false`、
   `finished:false`、`winner:null`、move.at 也全是「模型已知或永不使用」。
   **实测口径**（用户实弹的 4 手五子棋 game_move 局面，~3.2 字符/token 粗略换算）：
   原始全量形态 ≈1.9KB（≈600 token，日志与棋盘占九成、随对局线性增长）→ 用户粘贴的
   中间版 526 字符（≈164 token）→ 最终扁平版 99 字符（**≈31 token**）；其中行动信息
   （describe + 轮次）不足 15 token。

## 落法（服务层 + 工具投影层；client 零改动）

1. **快照头去日志，换 `moveCount`**：`GameSessionSummary` 移除 `moves`，加
   `moveCount`（总量锚）。日志读取只经有界窗口面
   `GameSessionStore.history(sessionId, {from?, limit?})`：`limit` 夹 [1, 200]（缺省
   20，非整数回落缺省），`from` 为窗口首条 0 基下标（缺省 = 最近 limit 手起点，夹进
   [0, moveCount]）。钳制单一来源在 store；工具层只做整数形态检查——agent bundle
   刻意不 import sessions.ts（handle.ts 的「小 seam」纪律，见下否决项）。
2. **工具载荷全部扁平最小化**（token 经济裁定核心）：身份面（players/动作词汇表）
   只在 `game_list`/`game_start` 出现一次；回合载荷只带「下一步动作与叙述」所需；
   零信息字段缺席即默认（不写 `finished:false`/`orphaned:false`/`winner:null`）。
   - `game_start` → `{sessionId, gameName, players, turn, turnOwner}`——不再回初始
     棋盘（默认路径人类先手，下一手是 game_wait，棋盘此刻没人需要）。
   - `game_state` → `{sessionId, gameName, turn, turnOwner, moveCount, finished,
     winner?, summary?, orphaned?, state, legal}`——落子决策的最小工作面。
   - `game_history`（新）→ `{sessionId, gameName, moveCount, from, finished,
     winner?, summary?, moves:[{actor, action, describe}]}`——记录投影三字段
     （at/summary 留在盘上）。
   - `game_move` → `{sessionId, describe, finished, turn?, turnOwner?, winner?,
     summary?}`——只有叙述文案与「下一步给谁」；实测 526 → 99 字符
     （≈164 → ≈31 token）。
   - `game_wait` → `{status, sessionId, newMoves, turn?, turnOwner?, winner?,
     summary?}`——`newMoves` 是等待期间到达的手（恒 ≤1：任何一手翻转回合、循环首读
     即返回）；立即 your-turn（人类手在 wait 之前落地）时恒空，局面经 game_state、
     往手经 game_history 补齐。等待循环改经 `history()` 读快照 + 增量（首读
     `limit:1` 只立 moveCount 基线），顺带**不再每拍重算 legalActions**（旧循环走
     `state()`，每 1s tick 为象棋算一次 44 步建议集）。
   - 终局/孤儿时轮次字段缺席：引擎 `state.turn` 停在最后一手，不能读成「轮到谁」
     （模型以 finished/status/winner 判定）——turnBrief 的显式守卫。
3. **角色归属随懒段常驻**：回合载荷不带 players 后，「我是谁」由 order -63 懒段的
   会话行携带（「你执 <agent 角色>，轮到 <角色>（归属）」）——压缩/换上下文后不需
   工具补读，且懒段是 system prompt 的缓存面、不计入每手载荷。

## 代价与否决项

- **代价如实**：常见回合从 2 次工具调用（game_move → game_wait）变为 3 次（+1 次
  game_state 读局面；进程内文件读、非网络往返），换取每手载荷**不随对局长度增长**
  且身份/审计噪声清零。
- **否决：per-agent 已读游标（把「增量」定义成「自 agent 上次所见」）**。需要新增
  持久态（会话文件里挂 agent 游标）并在压缩/换绑场景漂移；LLM 调用方持有的上下文
  不保证连续，游标失准即静默丢手。取「等待期增量 + 按需直读」的无状态语义。
- **否决：把 limit/from 的夹紧复制进 agent bundle**（本地常量二份）。会为两个数字
  把 sessions.ts（含 node:fs）拖进 agent bundle，违背 handle.ts 的「小 seam」纪律；
  类型面用 `import type` 擦除即可。
- **否决：HTTP 面另加 history 端点 / 把面板面一起瘦身**。本次需求是 agent 工具面；
  HTTP 载荷不进 LLM 上下文、面板另有消费字段，没有收益就不动（删除路径纪律）。
- **否决：让 wait 继续携带棋盘**（保留 view 以免每回合多读一次）。棋盘是「当前状态」
  而 wait 的职责是「等待期增量」——两者挤在一起正是本需求的起点；±1 次进程内读换
  语义清晰与载荷不膨胀，取拆分。

## 语义边界（如实标注）

- `newMoves` 只统计**等待期间**（首次读快照立基线之后）到达的手；调用前已落的手不在
  增量里（立即 your-turn 场景恒空）——局面/往手经 game_state/game_history 补齐。
- `game_start` 不再回初始棋盘：Agent 执先（显式 role）时需先 game_state 再落子；人类
  执先（缺省）时零浪费。
- 终局会话的轮次字段缺席（明确不把引擎残留 `state.turn` 当下一手）。
- `from` 越界夹到 `moveCount`（空窗）；`limit` 0/负数夹到 1、非整数回落 20、上限 200。
- 会话文件格式零变化：旧会话文件直接可读（`moves` 照旧在盘上），删除路径无迁移。

## 测试与 gates（基线对账随实现提交）

- `games-tools.spec`：五工具→六工具（注册面 + 种子 + 句柄缺失）；扁平载荷断言——
  game_start 无 view/session、game_move 无 view/session/日志且终局轮次缺席、game_state
  扁平面（state/legal/moveCount）、wait 四路（立即 your-turn 空增量/唤醒恰一手三字段
  投影/超时/终局含认输手）、game_history 窗口（缺省尾窗/分页/from 越界/limit 上界/
  非整数回落/寻址）、懒段「你执 o」。
- `games-service.spec`：`session.moves` 断言改经 `history()`；新增 history 窗口 describe
  （分页/钳制/越界/负数；长日志 25 手经会话文件注入构造——井字棋九手即终局，
  真实 store 的尾窗 20 语义用它钉死）。
- `games-import.spec` / `agent-tavern-tools.spec` / `agent-tavern-mount.spec`：
  快照断言改 `moveCount` + history；工具名单 23→24。
- gates：agent-tavern-isolation marker 六名 + `game_history` 专属负样本自测
  （goodAgent 六名列表里逐名摘除均须翻红）。
- 实测对账：测试基线 98 文件 1466 过 +1 跳 → 98 文件 **1470 过 +1 跳**（净增 4：
  games-tools +2、games-service +2）；15 gates 全 PASS；`pnpm run check` exit 0；
  dist 六件 + version stamp 随 check 例行重建（v0.6.3）。

## 版本连带（0.6.2→0.6.3）

补丁位（对外契约面：HTTP 摘要去掉 `moves` 属内部面、前端不消费；agent 工具面是新
协议但同属插件内 agent profile）。升版触发既定守卫连带：story-clock 示例 engines
`^0.6.2`→`^0.6.3`（其 spec 以 `PLUGIN_VERSION` 装载全部示例）、`mod-api.md` engines
示例值同步；五子棋参照包 engines 维持 `^0.6.0`（0.6.x 全系含 0.6.3）。
