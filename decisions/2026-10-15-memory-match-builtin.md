# 内置记忆翻牌对战（提案 0018 §4.1 内置序列第六款）

> 日期：2026-10-15。需求源：用户——「新建内置游戏 记忆翻牌对战 轮流翻牌，
> 配对成功得分」。设计契约与先行件：
> [提案 0018](../docs/proposals/0018-agent-game-bridge.md)（§3.2/§3.3 引擎与
> 视图契约、§4.1 内置序列、§14 token 经济裁定、§19 七次补记）、
> [决策 2026-10-14-gomoku-builtin](2026-10-14-gomoku-builtin.md)（「内置 =
> 开箱可玩面」裁定）、[决策 2026-10-14-blackjack-builtin](2026-10-14-blackjack-builtin.md)
> （暗牌延迟决定的隐藏信息纪律）、内置井字棋/五子棋/象棋/军棋/21 点参照实现。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 回答 |
|---|---|
| 所有者 | `src/games/builtin/memory.ts`（引擎 + 内联视图单一文件）为内置记忆翻牌对战唯一 owner；registry 装载数组、gates 标记块、games-memory.spec、两处内置数组断言各属其链路 |
| 唯一事实来源 | 内置游戏定义 = engine.meta（与 MANIFEST 同源同值）；对局状态以 `$DSH_HOME/tavern/games/sessions/*.json` 为准（会话面零改动） |
| 持久态及理由 | 零新增持久态——0 文件依赖、随 bundle 分发（viewHtml 字符串常量内联，gomoku/blackjack 先例）；**未翻开的牌面不进 state**（由 seed 派生，见「隐藏信息设计」） |
| 临时态 | 视图本地三件：选牌集、发送锁（4s 解锁兜底）、翻回预览 1.4s 计时——per-mount iframe、无持久化、token 纪律不变 |
| 外部依赖 | 零新增：复用 standard.ts 契约校验/烟测 + view.ts 桥注入管线 + parseBoardCoord 坐标归一 |
| 注册入口 | `registry.loadBuiltins()` 装载数组（六内置）；无新路由/工具/提示段；client 零改动（数据驱动） |
| 删除路径 | 删 `builtin/memory.ts` + 装载数组一项 + gates 标记块（含负样本）+ games-memory.spec + games-builtin/games-xiangqi 两处数组断言回滚 |
| 兼容对象 | 工具名/Mod API/state.json 零变化；版本连带见「版本」节；测试基线 +33（新增一个测试文件） |

## 规则裁定（v1 最终面）

- **盘面**：4×4 = 16 张、8 种图案各两张（单字汉字：月/星/花/雷/鱼/蝶/山/水）；
  牌位下标行主序 0-15（列 A-D、行 1-4，0=A1、15=D4）。
- **一手 = 一次动作** `{type:'flip', a, b}` **同手结算**——原子性、无「翻开
  第一张等第二张」的半手中间态。裁定理由（The Algorithm 的删除步）：半手态
  会让每手变成两次 game_move（模型两轮 + 两份载荷），与 §14 token 经济裁定
  （每手一次工具调用、行动载荷不随对局膨胀）直接冲突；且无半手态的状态机少
  一个相位（无 pending 字段、服务层零特判）。
- **配对成功** = 得 1 分 + 两张保持翻开（定格）+ **同一方继续翻**：经典
  Concentration 规则（配对 = 得分 + 保留回合）。用户「轮流翻牌」的裁定：
  「轮流」体现在**失配换手**；配对连锁是最标准玩法，也让「配对成功得分」
  的奖励同时作用于得分与节奏。如需「严格轮流、配对不保留回合」变体，应另立
  游戏 id（同 21 点「庄家自由决策变体」纪律）。
- **失配** = 两张翻回背面 + 换对方。
- **终局** = 8 对全部配完，比总分：高者胜、同分平局（winner null）。16 张
  全翻开本身就是终局 payoff（视图终局保留完整盘面 + 盘面之下 in-flow 结果
  条，同 0.6.3 既有语义与 21 点截图驱动纪律）。
- 不实现（v1 明示裁剪）：计时/步数限制、先手让子、多副牌加大盘面、悔棋
  （重放日志支撑但 v1 不做）；保留动作 resign 由运行时统一处理（引擎收到抛错）。

## 隐藏信息设计（本款最关键一条）

桥契约里 state 对视图（game-state 下行）与 Agent（game_state 工具）**全明**、
无按角色脱敏的通道。落法与 [21 点「暗牌延迟决定」](2026-10-14-blackjack-builtin.md)
同科：**未翻开的牌面不进 state**——

- state 只携带已被双方看见的事实：已配对的定格面（board 非 null 项）、最近
  一手（lastFlip：两张下标 + 两面 + 配对结果）。任意牌位的图案由 **seed 确定性
  派生**（`layoutOf(seed)`：8 图案各两张 Fisher-Yates），翻牌那一刻才物化。
- **「防偷看不变式」是可执行断言**（games-memory.spec）：开局 8 种图案一个都
  不在 state 的序列化文本里；失配一手后仅该手两张的面经 lastFlip 物化、其余
  仍不出现。
- 信任边界如实：state 带 seed 与派生纪律（与 21 点牌靴同款——「读取 state
  直接得到答案」不存在；程序化重建 RNG 可推演全盘，这是全明 state 下防偷看的
  上限，不假装更强）。
- 记忆面公平性如实：Agent 可经 game_history 复读往手 describe（含牌面）——
  审计日志是桥的既定设计（不可裁剪）；视图侧以「上一手」横幅与 1.4s 翻回
  预览辅助人类，不提供持久历史面。这是「谁记得住」类游戏的工具面固有不对称，
  留档不掩饰。

## 建议集语义

`legalActions` = 任意两张未翻开的牌（图案未知时任意对等价，无质量排序语义）；
开局 C(16,2)=120 超 §3.2 的 64 上限——按行主序截断至 64（前 15 对即 (0,j)
全跨度：任意截断下每个未翻开牌位都被覆盖）。applyAction 按全量规则终审任意
动作；视图不依赖建议集（可点 = 未翻开且未选中，引擎终审），无 xiangqi/junqi
「只放行建议集」的 400 风险面。

## 落法

1. **引擎**（`builtin/memory.ts`）：state `{ turn, seed, board[16], scores,
   ply, lastFlip, finished, winner }`；`layoutOf(seed)` 纯函数派生布局；
   校验序镜像 gomoku/blackjack（形状 → type → 未终局 → 角色 → 回合 → 坐标
   （parseBoardCoord 引号串归一）→ 两张不同 → 两张都在背面），深拷贝不改入参，
   中文报错；`describe` 在落子前 state 上算牌面与配对结果（game_move 只回
   describe——配对与否/续手换手必须写进叙述）；全文除 createGame 缺省 seed
   （node:crypto randomInt 唯一随机点）无随机/时间源，spec 扫源码钉死。
2. **视图**（同文件内联 viewHtml，`data-game="dsh-tavern.memory-match"`）：
   绿绒牌桌 4×4 + 行列坐标角标；**两段点击选牌**（第一张高亮待选、再点取消、
   第二张提交 {a,b}），提交后发送锁冻结到局面更新（4s 兜底解锁防回执失败死锁）；
   **失配翻回预览**：新失配一手到达时两张短暂亮面（面来自 lastFlip，双方都
   看见过、零泄漏），~1.4s 后翻回——纯视图动画、不写任何状态；配对定格金框；
   比分板按 owner 标注 你/AI 与当前行动方；终局盘面完整保留 + 盘面之下 in-flow
   结果条。坐席归属纪律同 21 点：人类未必执红，一切表述按 owner 反查落笔。
3. **registry / gates / 断言**：装载数组第六款；server-bundle 增
   `dsh-tavern.memory-match` 标记 + `memory-removed` 负样本；games-builtin.spec
   与 games-xiangqi.spec 的内置数组断言（五→六）——**第二处断言由首轮全量
   测试揪出**（只改了一处就以为穷尽，真实教训：内置数组断言在库里有两份）。

## 测试与验收

| 阶段 | 基线 |
|---|---|
| 起点（仓库 HEAD 5080ffc，README 基线） | 101 文件 1578 过 + 0 跳 |
| 内置记忆翻牌对战 | 新增 tests/games-memory.spec.ts 33 项（净增 +33）；games-builtin/games-xiangqi 仅改内置数组断言（五→六），零净增 |
| 合并后当前树 | **102 文件 1611 过 + 0 跳**（等价预算全量实测） |

`pnpm run check` 全链验证：tsc -b 零错 + vitest 全绿（等价预算）+ dist 六件随
v0.6.5 重建 + 15 gates 全 PASS。server-bundle gate 实测 dist：
`dsh-tavern.memory-match` 3 处 id 字面量、`PEEK_MS` 视图锚点在包、汉字牌面以
`\uXXXX` 转义随包（emoji 零残留）、version stamp v0.6.5。

spec 覆盖面（33 项 / 11 组，蓝军纪律——**布局派生不复刻洗牌实现**，一切牌面
结论只经引擎输出反推）：清单/形状/视图自包含与 view 管线（CSP + 桥脚本）/
静态锚点（.card.peek/.card.matched/PEEK_MS/onPick/result-strip/PREVIEW_STATE，
无覆盖层）/createGame 四例/布局不定式（8 图案各恰两张、同 seed 两局一致=重启
续局语义、配对判定与派生一致）/防偷看不变式/配对与失配语义（定格、换手、
describe 与 apply 一致、已配对拒翻）/终局两态（全知 8–0、手工 4–3→4–4 平局）
/确定性（同态两打 + 整局重放）/建议集（120→64 截断覆盖全牌位、中局
C(6,2)=15 全集、建议集外仍可执行）/describe（四类未识别回落 + 引号串容错）/
非法动作全家族/尺寸/烟测五关/真实 service 端到端——「记忆机器人」只用
describe 观察到的牌面决策（三规则：已知对优先 → 翻未知学信息 → 全知后剩余
必为整对必然命中），人机双路径交替翻完全盘，终局与机器人记忆逐张对账。

## 真机验收（headless Chromium 150 + CDP 截图驱动）

本机无 agent-browser CLI，按既有游戏批次纪律走宿主 chromium + 原生 CDP
（file:// 装载真实 view 管线产物 + 自投递 `dsh-tavern:game-state`，token 与消息
同值）。**28 项断言全绿** ×2 轮（含修订后复跑）：①预览态（16 牌/4 定格/
无点击/你- AI 标注）②人类回合两段点击 → 上行 {a,b} 捕获与坐标对账 + 发送锁
③AI 回合翻回预览（两张亮面、面与 lastFlip 一致、1.7s 后翻回背面且未写状态）
④终局（结果条「红方胜（你）」、全 16 张定格）⑤人类执蓝坐席（你/AI 反查、
可点 16、上行捕获）。截图 ×4 落盘（scratchpad，不入库）。

**截图驱动修订两处（如实留档）**：①首轮断言 1 项真实失败——人类回合横幅
文案未含「轮到你」（对齐黑杰克「轮到你行动」范式修订）；②截图检视发现
**表情符号牌面全量豆腐块**——真机环境（仅 CJK 字体）emoji 无字形，修订为
单字汉字（与 UI 同一字体上下文、渲染有保证；象棋/军棋汉字棋子先例），spec
零测试改动（布局只从输出反推的写法在这里兑现了红利）。另 1 项首轮失败为
验收脚本自身的复制粘贴笔误（失配后应 16 张可点，非 14），已修正。

## 本机检查偏差与环境说明（如实）

认证设备为 **Termux proot 容器**（2026-10-15 用户确认）——proot 的系统调用/
IO 路径显著慢于真实机，时序敏感套件在此环境**间歇失败**（跨轮次失败用例不同、
隔离复验通过，均与本次交付零文件交集）：

- `tavern-store/tests/retrieval-matrix.spec.ts`：默认 10s hook 预算下 beforeAll
  超时（3 个 skipped 全部来自该套件、无固有跳过项；隔离 9.86s 通过）；
- `packages/plugin/tests/memory-maintenance.spec.ts`：间歇 `view.status`
  'error' 抖动（隔离亦复现 1/5——ReadMemory 用例 548/482ms 快速失败、非超时类；
  只 import tavern-store 与 src/memory-maintenance.js）；
- `packages/plugin/tests/agent-novel-driver.spec.ts` 与
  `tavern-store/tests/novel-store.spec.ts`：仅在本机最重负荷那轮各出现 1 项
  失败，隔离复验通过（novel-store 单测 303ms 全绿）。

**用户裁定（2026-10-15）：跳过上述环境敏感失败，不再追跑全量绿**。交付认证
据此收口：本批次内已实测一次干净全量（等价预算 `--hookTimeout=120000`）——
**102 文件 1611 过 / 0 跳全绿**；本次交付的 games 族 spec（games-memory 33 项
等）在全部后续轮次中逐次全绿、零失败；tsc -b 零错、15 gates 全 PASS（多轮
复跑一致）。与既往留档（2026-10-14 两轮修复提交的「不同轮次失败用例不同、
隔离全绿」）同款：本机偏差按环境因素留档，不改代码、不掩盖。

## 边界（如实）

- **配对保留回合**是经典规则裁定（见「规则裁定」）；严格轮流变体另立 id。
- `lastFlip` 持久于 state（跨手保留至下一手）：两张面双方都已看见、零泄漏；
  视图不保留更早的历史（翻回即从盘面消失——记忆游戏的本质）；挂载时不重放
  旧动画（首帧以当前局面为准）。
- 建议集 64 截断的完整覆盖依赖「(0,j) 对在行主序最前」的性质（16 牌位恒成立；
  本款盘面固定 4×4，无变盘）。
- 终局后 `state.turn` 停在最后行动方（合法角色值），winner 以总分裁决；平局
  （同分）是合法终局（8 对偶数、4–4 可达，spec 手工局面钉死）。
- Agent 可经 game_history 复读往手（记忆外挂）；人类仅「上一手」横幅 + 记忆。
- 极简环境字体面：牌面为单字汉字（渲染取决于 UI 同款 CJK 字体；本机验收
  WQY Zen Hei 实测全字符可渲染）。
- 0.6.4 宿主不含本内置：需升级插件（桌面档位走自更新）。

## 版本（0.6.4→0.6.5，特性增量）

新增一个内置游戏（第六款）为特性批次，按家法升补丁位：根 package.json 与
packages/plugin/package.json 0.6.4→0.6.5；story-clock 示例 engines
`^0.6.4`→`^0.6.5`、mod-api.md engines 示例值同步（engines 漂移守卫
tavern-mods-examples.spec 对现宿主全绿）；dist 六件随 check 重建
（v0.6.5 5080ffc；本树工作区变更未提交，commit stamp 为 HEAD 短哈希，随提交
例行前移）。
