# 工具坐标容错：整数字符串归一（实弹 g-54e612c8 对局停摆修复）

日期：2026-10-14

## 背景

用户报：「检查 工具调用 Error: from 坐标必须是整数，收到 x="1"、y="0" … 游戏会话是
g-54e612c8」——中国象棋实弹对局（人类红 / Agent 黑）里 Agent 的 `game_move` 反复撞
坐标类型错误，对局停摆。设计契约：[提案 0018](../docs/proposals/0018-agent-game-bridge.md)
（§3.2 引擎契约、§3.4 动作形状、§4.2 工具面）。

## 取证（宿主会话事件日志逐条对账，先量后改）

证据源：`$DSH_HOME/sessions/--root-.dsh-tavern-workspace--/session-90f520b9-…/session.v4.jsonl.zstd`
（v4 事件日志逐帧解出，tool-call 原始 arguments 与 tool/result 成对核对）。同一对局
28 次 `game_move` 的逐条形态：

- **26 次**：原始参数即引号串（`"from":{"x":"1","y":"2"}`）→ 被引擎类型闸拒
  （`from 坐标必须是整数，收到 x="1"`）；
- **2 次**：原始参数是真数字（`"x":1`，seq 173/233）→ 解析通过——seq 173 落子成功
  （「黑方 炮2平5」，本局唯一成功的 Agent 手），seq 233 被规则正确拒
  （马 (1,0)→(3,2) 非法目标）。

判读：**引号串出自模型输出本身**（以日志原文为准，非桥转码）——同一模型同一工具，
真数字调用能过、引号串调用必撞；失败后 Agent 连续 27 次自救（调 key 序、数组、
转义 JSON 字符串、浮点 `"1.0"`、指数 `"7e0"` …）全部不收敛，对局停在 ply 3。
Agent 的 reasoning 自称「写的是数字」，与日志原文不符——以可核对的一线材料为准，
不以自述为准（这正是「错误回执 + 重试」在本案失效的直接证据）。

## 根因

插件的引擎坐标解析只认 JS number（`Number.isInteger` 一票否决），没有把「整数的
字符串形态」当作同义表示；宿主侧模型（MiniMax-M3.1-Flash-Preview）在工具调用 JSON
里把数字写成引号串且不可自控（26/28）。`"1"` 与 `1` 指向同一交叉点——这是**同一
动作的不同书写形态**，不是非法动作；把它推给重试纪律不收敛。

## 裁定：归一收在引擎坐标解析（与两端契约的关系）

- **工具层/桥不改**（§3.4：动作是游戏自定义 JSON，桥透传、不解释字段语义）；
- **引擎自己的解析器归一**（每个游戏最懂自己的动作语法）：`standard.ts` 新增
  `parseBoardCoord(value)`——数字原样；整数的字符串形态（`"1"`、`" 7 "`、`"1.0"`、
  `"7e0"`）归一为数字；小数/空串/非数文本返回 `null`，引擎沿用原中文报错；
- **与 [2026-10-11-mvu-schema-guard](2026-10-11-mvu-schema-guard.md)「不强转」的辨析**
  （刻意区分，不是双标）：MVU 拒绝 `"3"→3` 是因为强转会把模型错型的值静默写进
  **持久态**、制造模型看不见的状态分叉。本场景三点不同，故裁定相反：①动作是一次性
  输入，不落盘「模型写过什么」——棋盘只留几何结果，无类型残留；②归一只发生在无歧义
  的同义上，界内与规则仍全量终审（实弹 seq 233 的行为被新用例钉死）；③该形态不可
  自控、重试不收敛。

## 落法（四内置 + 参照包）

| 文件 | 改动 |
|---|---|
| `src/games/standard.ts` | 新增 `parseBoardCoord`（导出，含语义注释） |
| `src/games/builtin/xiangqi.ts` | `readPoint` 接入（applyAction 与 describe 同一解析） |
| `src/games/builtin/junqi.ts` | `readPoint` 接入（同上） |
| `src/games/builtin/gomoku.ts` | `applyAction` 坐标解析 + `describe` 同步 |
| `src/games/builtin/tic-tac-toe.ts` | 同上 |
| `examples/games/dsh-tavern.gomoku/engine.mjs` | 内联 `parseCoord`（参照包自包含，不 import 插件内部模块） |

describe 必须同步的理由：sessions.ts 在 applyAction 前取 describe——若 describe 不认
引号串，历史落「动作未被识别」兜底文案，容错必须覆盖叙述面（新用例对两档都断言记谱）。

## 防线（测试）

- `games-builtin.spec.ts`：`parseBoardCoord` 单元（7 收 / 11 拒）；井字棋 + 内置五子棋
  各 +1 容错用例；原「字符串 `'0'` 拒绝」负样本改为非整数串（`'0.5'`/`'0x'`）。
- `games-xiangqi.spec.ts`：+1 引擎容错（引号串落子 + describe 记谱）；+1 实弹形状
  端到端（真实 GamesService：引号串炮2平5 成功 → 引号串非法目标仍被规则拒 → 引号串
  马2进3 成功，moveCount=4）；负样本改 `'1.5'`/`'abc'`。
- `games-junqi.spec.ts`：+1 容错（营长进营 + describe）；+1 非整数串拒绝。
- `games-gomoku.spec.ts`（参照包）：+1 容错；负样本改 `'7.5'`。

## 验证

- 游戏族四 spec 全绿（165 用例）；tsc 零错；构建 v0.6.4（4067ea7）六产物随 check 例行重建
  （解码核验：容错正则与 `parseBoardCoord` 在包内、旧双 `Number.isInteger` 坐标闸不在包内）。
- 15 gates 全 PASS。
- **完整 `pnpm run check` 的本机偏差（如实留档）**：
  `packages/tavern-store/tests/retrieval-matrix.spec.ts` 的 beforeAll 10s hook 预算在本机
  超时（隔离单跑亦超；`--hookTimeout 120000` 单跑 5/5 全绿，纯机器速度边界）——
  与本变更零交集：tavern-store 检索矩阵，无任何 import 路径到 `games/*`；
  另有 memory-maintenance 两项在负载下的偶发（隔离与全量各一次全绿）。
  游戏族口径不变：101 文件 1576 过 +1 跳（+7 用例为本轮新增，逐条见「防线」）。
- fix 随 0.6.4 线不升版本（家法同 345fdec 与 blackjack-seat-ownership）。

## 边界（如实）

- 只归一「整数」：`"7.5"`、`"abc"`、`"0x7"` 等仍拒（不猜、不截断）。
- 覆盖我方引擎（四个内置 + 参照包）；导入 / Mod 游戏自持其坐标语法（桥不替其解释
  动作字段；建议第三方照抄 `parseBoardCoord` 语义）。
- 模型侧引号习惯不修（宿主 / 供应商行为，插件不可控）——本层是「让正确意图穿过
  书写噪声」。
- 既有停摆局（g-54e612c8 停 ply 3）不自动复活：升级后 Agent 重试同形坐标即可续弈。
