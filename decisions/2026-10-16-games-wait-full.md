# game_wait_full：带棋盘视图的等待变体（游戏工具面第七件）

> 日期：2026-10-16。需求源：用户——「当前 2026-10-14@20h28m21s478ms 这个
> agenttavern 会话中，感觉工具调用偏多，game_wait 后面又接查看状态，说明
> wait 返回的数据可能不太合理」，随后裁定方向：「game_wait 在更轻量的游戏上
> 表现更好，模型不会调状态，可不可以新增个带状态返回的」。设计契约与先行件：
> [提案 0018](../docs/proposals/0018-agent-game-bridge.md) §4.2（六件工具面）、
> §14（token 经济修订——wait 只回增量）、[decisions/2026-10-14-games-delta-tools.md](2026-10-14-games-delta-tools.md)。

## 问题与裁定

真机会话实证的模式：`game_wait` 返回后 Agent 紧跟一发 `game_state`。根因在
契约而不在模型：wait 的返回面（§14）只有**等待期增量**（newMoves + 轮次/
终局），而重棋局（地牢/大富翁/象棋）上 describe 文案不足以支撑决策——模型
要看棋盘，只能补读。轻量局（井字棋）上 describe 已足够，模型不补读——极简
wait 在那里就是最优解。

**裁定（用户指定方向）：不动 `game_wait` 契约，新增 `game_wait_full`**——
同款阻塞等待（同款等待登记/唤醒/超时/中止语义），返回在增量之上、当
`status === 'your-turn' || 'finished'` 时附带 `view`（`game_state` 同款五字段
载荷：state + turn + legal + finished + summary）。模型按局选工具：要看着
棋盘决策的对局用 full（等待返回即可落子，省一发往返），轻量局继续 wait。
备选「wait 加 withView 参数」被否：参数式开关依赖模型自觉传参，且把单一
工具的返回面变成两态（消费端更难预期）；双工具名在描述里互指（wait 描述
尾注「需要棋盘决策时改用 game_wait_full」）更直白。

## 落法（agent bundle 单文件 + 三处联动）

- `agent-tavern/agent.ts`：`waitForHumanMove` 增 `options.includeView`（payload
  按 status 条件附加 `view: (await service.state(sessionId)).view`——注意接口
  名是 `state` 不是 sessions store 的 `get`，实现期笔误已纠）；注册
  `game_wait_full`（参数与 wait 全同：sessionId 缺省寻址 + timeoutMs 钳制
  1000..900000 缺省 5 分钟）；`gameWaitFullOutput` schema（wait 同字段 + view）；
  `game_wait` 描述尾注交叉引用；懒段（order -63）指引补「局面复杂、需要看着
  棋盘决策的对局改用 game_wait_full：同款等待，返回附带棋盘局面（state +
  legal），无需再跟发 game_state」。
- `mods/cross-bundle.ts`：`BUILTIN_TOOL_NAMES_SEED` 增第七名（静态种子漂移由
  vitest 对账锁定）。
- gates：`agent-tavern-isolation` 的 agent bundle 工具名标记组（六→七）+ 自证
  good 样本同步。

## 返回面契约（v1）

- `status: 'your-turn'` → 增量 + **view**（决策即落子，零跟发）；
- `status: 'finished'` → 增量 + **view**（收尾叙述可看终盘）；
- `status: 'timeout' | 'orphaned'` → 无 view（局面未变/只读，无决策可做）；
- `game_wait` 返回面**零变化**（既有 token 经济契约与测试原样成立）。

token 经济对账：full 的 view 是有界载荷（≤64KB 契约上限，实测棋类 1-3KB、
地牢 1-9KB），替换的是「wait + 跟发 game_state」两发调用中的一发——重棋局上
净省；轻量局模型继续用 wait，零额外成本。§14 反对的「每手回吐全量日志」
（线性膨胀）与 view（常数有界）不同物。

## 测试（games-tools.spec +4；dungeon/tools/mount 联动修正）

- game_wait_full 四路：已轮到 Agent 立即返回（view 五字段全验：board 落子/
  legal 计数/summary）；人类回合阻塞 → 落子唤醒（newMoves + view 同返、等待
  登记挂起与释放）；timeout 无 view；等待中人类认输 → finished 带 view（终盘
  finished/legal 空/summary 认输）。
- 联动：注册面「七工具存在」+ 种子对账七名；agent-tavern-tools roster 精确
  数组 +1；agent-tavern-mount 工具总数 24→25；懒段断言补 game_wait_full。

## 边界（如实）

- view 读取发生在等待结束的返回路径上（`service.state` 串行读），与 newMoves
  之间理论上有微秒级窗口（极快连落两手）——view 恒为新态，最坏是 newMoves
  少记一手（该手在下次 history 窗口可见），非一致性破坏；
- 工具总数 +1 的选择成本由描述互指消化（wait/full 各自描述写明适用面），
  真机上的工具选择准确率待实弹观察（若模型混用，懒段指引可按游戏品类细化）。


## 实弹修复（同日）：objectOutput 第二参语义误读——timeout 路径被宿主 schema 校验拒收

真机报错：`tool "game_wait_full" returned invalid output: missing required property
"value.view"`（timeoutMs 600000 等满超时路径）。根因：`objectOutput(properties,
optionalKeys)` 的第二参是**可选键表**（required = 属性键全集 − 可选表），首版
`gameWaitFullOutput` 把 `view` 声明进 schema 却沿用了 wait 的可选表——view 被判
必填，而 timeout/orphaned 有意不带棋盘（token 经济），宿主按 output.schema
校验返回即整体拒收。修复：`view` 进可选表（语义不变——超时/孤儿仍不带）。

测试缺口同步补（这是比 bug 本身更值钱的发现）：本套件历来只断言属性面、
**从不按声明的 output.schema 验收工具返回**，宿主侧校验在 vitest 里不可见。
新增 `expectConformsToSchema` 最小校验器（required 键必须在场）挂到
game_wait_full 四路返回面 + game_wait 既有 your-turn 用例——回到坏实现即翻红。
