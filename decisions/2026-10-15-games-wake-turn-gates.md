# 自动续弈的回合闸与运行中闸：决定窗提前唤醒与运行中回合陈旧通知的竞态修复（提案 0018 §21）

> 日期：2026-10-15。需求源：用户——「修复大富翁游戏下 自动游戏通知（非用户消息）：
> 对手已在「大富翁」棋盘落子，继续对局。sessionId: g-60bfb716 异常触发的问题，
> agent 明明还在循环输出中」。先行件：[提案 0018](../docs/proposals/0018-agent-game-bridge.md)
> （§15 自动续弈与本次 §21 竞态修复）、[决策 2026-10-14-games-autowake](2026-10-14-games-autowake.md)
> （本特性的原始语义锚：「Agent 没调 wait 就停止运行后，用户操作完游戏由插件自动
> 触发 agent 继续」）、[决策 2026-10-15-monopoly-builtin](2026-10-15-monopoly-builtin.md)
> （决定窗多动作玩法的来源）。本文记录真机取证、RCA、落法、边界与对账。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 回答 |
|---|---|
| 所有者 | `src/games/wake.ts` 单文件（投递决策两点）；触发出口（`service.ts` 的 `onHumanAction` 回调）与接线（`index.ts`）原样不动 |
| 唯一事实来源 | 回合归属/终局以 `GameSessionSummary`（`turn`/`players`/`finished`，会话快照投影）为准；「是否运行中」以宿主 agent 句柄 `status` 为准（读不到即降级不拦） |
| 持久态及理由 | 零新增持久态——两闸都是读时判定的纯函数 |
| 临时态 | 零新增 |
| 外部依赖 | 既有宿主面：`ctx.agents.get(id)` 句柄的 `status` 属性（'idle'/'running'）——agent-novel driver（`DriverAgentLike.status`）与 index.ts `/compact` 路由（`agent.status !== 'idle'` 拒绝）早已在生产使用同一属性，非新能力 |
| 注册入口 | 无——纯内部判据（通知仍只在人类落子成功出口产生） |
| 删除路径 | 删 `turnReachedAgent`/`agentTurnRunning` 两函数与两行调用 + games-autowake.spec 五例 + gates 两 marker 与负样本——零数据迁移 |
| 兼容对象 | 旧宿主 agent 句柄无 `status` → 不拦（行为回到本次修订前）；会话文件 / 工具面 / HTTP 形态 / client 零变化；「一次交出回合的人类动作恰一条通知」取代旧「一次人类动作一条」——被抑制的唤醒由懒段 + 下次消息兜底覆盖（与 §15 既有降级同语义） |

## 查证（为什么这么修）

- **宿主面**：`Agent` 句柄带 `status: 'idle' | 'running'` 与 `whenIdle()`。生产先例两处：
  `index.ts` 的 `/compact` 路由以 `agent.status !== 'idle'` 拒绝（927-930 行）；
  `agent-novel/driver.ts` 对 `status !== 'idle'` 的 agent 先 `await whenIdle()` 再调度
  （323-330 行）——但那是**调度语义、不在 HTTP 回执路径上**。
- **引擎语义**：所有引擎按 `actor === state.turn` 校验落子（大富翁 monopoly.ts
  `applyAction`、21 点 blackjack.ts、运行时 `currentRoleOf`）。人类动作成功 ≠ 轮到
  Agent——「单回合多动作」玩法里 turn 会停在人类：大富翁 `roll` 命中决定窗
  （`phase='decide'`，buy/build/pass 收尾才 `endTurn`；现金不足时无决定窗、直接
  收尾——settleLanding 374-447 行）、21 点 player `hit` <21 点回合不变、记忆翻牌
  配对成功保留回合。
- **真机证据（g-60bfb716，宿主会话 `session-5b9aa539`，zstd 多帧解出 884KB/503KB
  事件流）**：
  - 人类（红）回合几乎全部两次动作（07:53:22 roll「故宫」可购买 → 07:53:41 buy；
    07:58:31 roll 可加盖 → 07:58:36 build；……）；
  - 9 条通知（id 尾号 = moveCount：6/13/20/21/26/29/32/35/44），**5 条**（-6/-13/
    -20/-32/-35）对应决定窗 roll——投递时刻 `turn` 仍是人类，Agent 收到也只能
    game_state/game_wait（引擎必拒）；其余 4 条为该手真正交出回合的合法通知；
  - 9 条**全部**是 `agent/inbox/spliced`（`target:"next-turn"`）且全部落在**未结束
    的 turn 3**（07:51:19 起、71 个 step）——第一条 -6 距人类 roll 仅 9ms
    （07:53:22.996）：即用户看到的「agent 还在循环输出中，通知异常触发」；
  - 被 game_wait 挂起吸收的手（如 07:53:41 的 buy）按 §15 等待闸天然不投递——旧
    防重判据在它覆盖得到的范围内工作正常，漏的是它覆盖不到的两种时刻。

## RCA（5-Why）

1. 通知在 agent 运行中、且有时在人类回合还没交出的时刻被投递；
2. 因为投递判据只有「是否正在 game_wait 挂起」——不判「该手是否交出回合」、也不判
   「Agent 是否已结束回合」；
3. 因为 §15 的触发出口选在「一次人类动作的成功出口」（service.humanAction），而它的
   语义锚却是「Agent 没调 game_wait 就**结束回合**后、用户操作完」；
4. 因为「单回合多动作」玩法（大富翁决定窗等）让「人类动作成功」与「回合交到 Agent」
   分离——大富翁里前者是后者的超集；
5. 根因：**事件型唤醒的判据没有与语义锚逐条对应**（锚有两段——「结束回合后」与
   「用户操作完（交出回合）」，实现只落实了第三段「不在 wait 中」）。

## 落法（src/games/wake.ts 两点，单文件）

1. `turnReachedAgent(session)`——回合判定：`finished` 恒真（收尾叙述；含人类投降、
   人类动作终结对局——此时 turn 可能停在人类，但「请收尾」与回合归属无关）；否则
   `players` 按 `turn` 反查 `owner === 'agent'`；`turn === ''`（不可判定）按不投递
   降级。不满足即在查绑定前短路（零 store 读、零日志噪声）。
2. `agentTurnRunning(agent)`——运行中判定：live agent `status === 'running'` 不投递。
   运行中的回合经自己的 game_wait/game_state 读面吸收该手（真机路径即如此：等待
   循环吸收 + 「立即 your-turn 恒空」语义）。**刻意不做** whenIdle 等待投递：本
   函数在人类落子 HTTP 回执路径上被 `service.humanAction` await，等待会卡住棋盘
   回执；且「等空闲再投递」会回到陈旧回合问题（回合结束时往往已吸收了该手）——
   与 agent-novel 驱动的 whenIdle 等待刻意不同（那边是调度语义、不在回执路径上）。
   status 缺失/未知（旧宿主形状）→ false，不拦，走懒段兜底。
3. 通知 id 语义从「一次人类动作恰一条」更新为「一次**交出回合的**人类动作恰一条」；
   `noticeText`/source 形状/幂等 id 规则不变。

## 语义边界（如实标注）

- 人类极快交回合而 Agent 的上一回合仍在运行：本闸不投递，由该运行中回合吸收；若该
  回合未吸收即结束（未 wait）→ 回落既有兜底（懒段 order -63 常驻摘要 + 下次任一
  消息唤起），不重试（事件语义不变）。这是与「运行中不打扰」的取舍，比投递后被
  排队成陈旧回合（真机 9/9 皆为陈旧队列标本）更符合 §15 的 token 经济裁定。
- 终局通知同受运行中闸：人类在 Agent 回合中投降时，若该回合自行观察到终局
  （game_wait/game_state 读面）即闭环；未观察到的缺口由兜底覆盖。
- 本次修订受益面是泛化的：任何「单回合多动作」游戏（大富翁决定窗 / 21 点连续 hit /
  记忆翻牌配对保留回合 / 未来导入 Mod 游戏）都从「交出回合才唤醒」受益；一动作一
  回合的游戏（五子棋/象棋/军棋等）行为不变。
- 旧宿主（agent 句柄无 status）不拦——行为回到修订前，符合逐属性降级纪律。

## 测试与 gates（基线对账随实现提交）

- `games-autowake.spec.ts` +5 例（8→13）：回合未交出零成本短路（不查绑定/无日志）且
  交回后恢复投递（幂等 id 取交回合那一刻的 moveCount）/ 终局不受回合闸限制（turn
  停在人类仍投递收尾）/ turn 不可判定不投递 / 运行中不投递与回 idle 恢复 / status
  缺失与未知值不误杀。
- gates server-bundle 增两 marker——`function turnReachedAgent(` 与
  `function agentTurnRunning(`——各配负样本自证（替换名互不含原子串）；dist 随
  `pnpm run check` 重建后两 marker 在包（解码核验）。
- 测试基线 103 文件 1676 项 → 103 文件 1681 项（+5；全量实测 0 跳过、exit 0，README
  对账）；tsc 零错；15 gates 全 PASS（含两新 marker 负样本自证）；游戏族 13 spec
  398 项全绿；dist 随 `pnpm run check` 重建后两 marker 在包（解码核验）。

## 决策要点（固化 SOP）

**事件型唤醒的判据必须与语义锚逐条对应**：锚写「Agent 结束回合后」，就必须检查
「回合已结束（status idle）」；锚写「用户操作完」，就必须检查「该手真正交出回合
（turn owner = 对家）」。只检查实现侧容易想到的那一条（「不在 wait 中」）会在
「单回合多动作 + 长回合循环」的真实玩法下把假陈述投递出去——真机 9 条通知里 5 条
是假陈述、9 条全部是运行中回合的陈旧队列标本。防重判据的测试要能钉死「零成本
短路」（不查绑定），否则后人容易把闸挪到副作用之后。
