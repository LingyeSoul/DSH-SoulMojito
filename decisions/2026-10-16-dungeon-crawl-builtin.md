# 内置地牢爬行（提案 0018 §4.1 内置序列第八款）

> 日期：2026-10-16。需求源：用户——「游戏服务有没有可能扩展成支持 Roguelike
> 或者 RPG 的模式，当前的小游戏有一些单调」，当日追加「做内置包地牢爬行」。
> 前置动作是**品类可行性评估**（当日对话，落点见提案 0018 §22）：游戏桥契约
> 约束的是形态（回合制、JSON state、确定性纯函数引擎），不约束品类——七款既有
> 内置全是双人对抗棋/牌盘，「单调」是内容问题不是架构问题。本款是第一款
> Roguelike 内置，验证「Agent 当地下城主」的非对称叙事节奏在既有桥上
> **零核心改动**可跑（sessions/service/工具面/client 全部零改动）。设计契约与
> 先行件：[提案 0018](../docs/proposals/0018-agent-game-bridge.md)（§3.2/§3.3
> 引擎与视图契约）、内置 21 点（暗牌延迟决定）、记忆翻牌（未翻开牌面不进
> state）、大富翁（单回合多动作决定窗、seed 派生双流、盲测调参纪律）。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 回答 |
|---|---|
| 所有者 | `src/games/builtin/dungeon-crawl.ts`（引擎 + 内联视图单一文件）为内置地牢爬行唯一 owner；registry 装载数组、gates 标记块、games-dungeon-crawl.spec 各属其链路 |
| 唯一事实来源 | 内置游戏定义 = engine.meta（与 MANIFEST 同源同值）；地宫布局 = carveFloor(seed, depth) 纯函数（可任意重算，永不落盘）；对局状态仍以 `$DSH_HOME/tavern/games/sessions/*.json` 为准（本变更零改动会话面） |
| 持久态及理由 | 零新增持久态——0 文件依赖、随 bundle 分发（viewHtml 字符串常量内联；**预览局面由引擎 createGame({seed:1}) 模块期实时生成并注入 JSON**，与引擎开局态零漂移，优于大富翁手工粘贴的静态副本） |
| 临时态 | 零新增（无缓存/无定时器；carveFloor 每次动作重算 ≤300 次游走迭代，无需记忆化） |
| 外部依赖 | 零新增：复用 standard.ts 契约校验/烟测 + view.ts 桥注入管线；确定性用自持 FNV 折叠哈希（hash01），seed 缺省走 node:crypto |
| 注册入口 | `registry.loadBuiltins()` 装载数组加第八项；无新 HTTP 路由、无新工具、无新提示段——`game_*` 六工具与面板「游戏」分区零改动即见新游戏；client 零改动 |
| 删除路径 | 删 `builtin/dungeon-crawl.ts` + 装载数组一项 + gates 的 dungeon-crawl 标记块 + games-dungeon-crawl.spec + games-builtin.spec 内置数组断言回滚——对局面零残留（会话只是数据） |
| 兼容对象 | 内置工具名/Mod API/state.json 零变化；不升版（随 0.6.5 线，同前三笔纪律）；测试基线 +1 文件 +39 项、games-builtin +1 项 |

## 品类论证（评估结论的落点）

评估给出的三条硬边界与本题的关系：① 会话恒「一人类一 Agent」——用
roles `['hero','world']` 双角色绕开单人局裁剪，且恰好落在本产品灵魂位上
（角色扮演层里 Agent 当 DM 是特性不是妥协）；② state 全明无投影通道——用
延迟决定做真迷雾（见下节）；③ 自动续弈回合闸（§21）在 turn 停留人类时不投递
——把「交回合给 world」设计成**战斗事件**（遭遇/怪物还击），探索全程 turn 留
hero，Agent 恰在值得开口的节点被唤醒。三条边界全部转为设计语言，无一条需要
动核心。

## 形态裁定（v1）：三层下探的探索者 vs 地下城主

- **角色**：`['hero','world']`——人类缺省执 hero（探索者），Agent 缺省执
  world（地下城主，**真实来打**怪物回合：attack/heavy/defend 三择，同 21 点
  「AI 做庄」纪律——引擎只做合法性终审与结算，抉择权在 Agent）。
- **地宫**：12×12 网格 × 3 层（40+4×深度格/层醉汉游走凿洞，连通性由构造
  保证）；入口恒 (1,1)，石阶 = 每层最后凿出的格；第三层石阶被炎魔君王占据，
  斩杀即通关；英雄 HP 归零则地下城吞噬冒险者。
- **主干**：英雄 4 向移动（切比雪夫 ≤2 半径揭示迷雾）→ 拾取/陷阱自动结算 →
  踏入活怪格遭遇战（怪先手）→ 攻击/喝药（喝药让回合）/脱离（走开即脱战）→
  站石阶下楼（**楼梯坍塌，揭示层弃置，无回溯**——state 尺寸纪律的品类化
  落法：满探索后全量 state 实测 <1KB，远低于 64KB 上限）。
- **节奏（引擎即节奏作者）**：探索动作全在英雄手内结算、turn 恒留 hero——
  **纯探索零 Agent 调用**（token 经济）；只有接战才逐手交替。§21 回合闸在此
  语义下精确投递：遭遇那一手交回合 → 「对手已落子，继续对局」真陈述。

## 迷雾与防偷看（三重延迟决定）

state 对视图/Agent 全明（桥无按角色投影通道），因此**未揭示的信息在 state
里不存在**：

1. **布局不进 state**：岩壁/可走格由 carveFloor(seed, depth) 纯函数随时重算，
   state.tiles 只存已揭示格——视图渲染迷雾用真数据（黑洞格 = 未揭示），
   Agent 读 game_state 也只能看到英雄走过的世界。
2. **armed 陷阱不进 state**：陷阱存在性由 hash(seed,depth,x,y) 判定，英雄踏上
   那一刻才结算并落 `trapSprung`——双方都无法偷看（已揭示的陷阱格无任何
   痕迹，测试用「揭示半径内的陷阱格无 trapSprung 键」钉死）。
3. **怪物/物品揭示才快照**：内容从纯函数进 state.tiles 的时机 = 英雄揭示
   半径扫过——此后血量/拾取是可变态，之前不存在。

与 21 点「暗牌延迟决定」、记忆翻牌「未翻开牌面不进 state」同一不变式的
Roguelike 化：**程序化生成的世界按需显影**。

## 规则面裁剪（v1 明示）

| 面 | 判定 |
|---|---|
| 4 向移动 + 切比雪夫 2 揭示 + 拾取/陷阱自动结算 | ✅ 实现（自动拾取省动作数——chat 节奏优先于 Roguelike 键数仪式感） |
| 遭遇战（同格接战、怪先手、攻击/喝药/走开脱战） | ✅ 实现（怪物静态不追击） |
| world 三择 attack/heavy/defend | ✅ 实现（heavy 35% 落空命中 ×2、defend 减半英雄下一击——给 DM 真实的风险表达面） |
| 武器/护甲换装（更优才换：铁剑+1/秘银剑+2、皮甲+1/板甲+2） | ✅ 实现（无背包管理——差装备留在格上） |
| 药水（+15，战斗中喝药让回合）与金币（击杀掉落 + 地面拾取，通关结算分） | ✅ 实现 |
| 下楼（石阶触发、揭示层弃置）与 Boss 终局（3 层石阶炎魔君王 32HP/攻5） | ✅ 实现 |
| 饥饿/视野道具/远程/法术/怪物移动与仇恨/背包/卖装备/跨局元成长 | ❌ 不实现（元成长需要跨会话持久面，属评估 Phase 1+ 范畴） |
| 回溯上层 | ❌ 不实现（楼梯坍塌叙事化） |
| 单人局（无 Agent 的纯单机 Roguelike） | ❌ 不实现（v1 会话硬裁剪 players.max===2；world 角色由 Agent 执是设计而非绕路） |

## 平衡面（30 seed × 2 DM 风格盲测，如实留档）

调参前（怪物攻 2+depth、Boss 36/6、药水 2 瓶 +12）：贪心直奔楼梯脚本
通关率 **3/30（10%）**，死因集中于 2/3 层空手英雄（atk4/def0）被磨死——
成长线太随机。四刀调整：怪物攻 1+depth、Boss 32/攻5、药水 3 瓶、治疗 +15。
调整后同款脚本：仁慈 DM（恒 attack）**20/30（67%）**、凶狠 DM（恒 heavy）
**11/30（37%）**。难度锚定逻辑：脚本只会直奔楼梯硬拼路上之怪、不会探索
拾取、不会绕行——人类玩家显著优于脚本；Agent 实际混用三择，真实胜率介于
两风格之间。死亡仍是被叙事的正当结局（seed 1 阵亡路径被端到端测试锁定）。

## 确定性设计（静态流 + 战斗流）

- **静态流** `hash01(seed, depth, x, y, salt)`：凿洞游走方向、格内容类别与
  数值——坐标寻址的纯函数（FNV 变体整数折叠，无模块态、无缓存）；
- **战斗流** `hash01(seed, state.rolls, ...)`：伤害 ±1 浮动、猛击命中、
  掉落掷——`rolls` 游标在 state 里（同输入两次调用 deep-equal，§3.2 硬约束；
  大富翁骰子流同款纪律）。
- 全文除 createGame 缺省 seed（node:crypto）外无随机/时间源（测试逐字扫描
  锁定）。陷阱伤害恒 2+depth 无浮动——「无战斗流参与的可精确断言」供测试
  钉死触发/不重复触发。

## 落法（四层）

1. **引擎 + 视图**：`builtin/dungeon-crawl.ts` 单文件（引擎 + viewHtml 内联
   + `dungeonProbe` 测试探针——导出 carveInfo/trapAt/contentAt/monsterAt/
   itemAt 只读数据面，镜像大富翁导出 tiles/chanceCards 的纪律）。
2. **registry**：装载数组第八项（import + loadBuiltins）。
3. **gates**：server-bundle 增 dungeon-crawl id 字面量标记（MANIFEST 与
   data-game 双处都在 bundle 里）。
4. **测试**：games-dungeon-crawl.spec（39 项）+ games-builtin.spec（内置
   数组与烟测 +1 项）。

## 测试对账（games-dungeon-crawl.spec，39 项）

- 清单/形状/烟测/view 管线/源码无随机扫描：6 项；
- createGame 契约（初始态字段、同 seed deep-equal、缺省 seed 两路、建议集
  非空全 move）：3 项；
- 防偷看不变式（未揭示格不在 state、armed 陷阱无痕迹踩中才显形且不重复
  触发）：3 项；
- 移动与探索（岩壁/边界/非法方向、下楼重置与坍塌叙事、最底层巢穴闸、非
  石阶闸）：6 项；
- 遭遇与战斗（遭遇建议集三择、attack 范围断言、heavy 两分支、defend 减半
  与结算即清、击杀掉落、Boss 终局、英雄阵亡、回合纪律双向）：8 项；
- 喝药与拾取（战斗中让回合、满血/无药闸、药水金币拾取、换装更优/留置、
  入口恒干净）：5 项；
- 终局与非法面、确定性（同动作 deep-equal、探索重放）：4 项；
- 端到端（seed 3 BFS 导航通关、seed 1 同款脚本阵亡、整局重放 deep-equal）
  + describe 叙述面：4 项。

蓝军纪律与大富翁同款：不镜像 hash/游走实现，随机相关断言只锁取值范围或
事件分支；受控局面用探针（BFS 寻路取证 seed 3 通关 / seed 1 阵亡）或手工
构造 state（引擎把 state 当数据读）。

## 验证

tsc 零错；games-dungeon-crawl.spec 39 项 + games-builtin.spec 52 项全绿；
全量四步分解验证（tsc -b 零错 / vitest 106 文件 1738 过 + 1 跳[host-package 的
POSIX-only 用例，与本变无关] / build-plugin v0.6.5 产物含 dungeon-crawl 引擎与
视图 / 15 gates 全 PASS 含新 id 字面量标记与负样本自证）。如实标注：单命令
`pnpm run check` 在本机并发 worker 全开时 vitest 阶段内存溢出（环境既有约束，
与本变无关——套件以 `--maxWorkers=4` 限并发全量通过，README 基线 1698→1738
对账）。

## 边界（如实）

- **怪物静态**：不追击、不动员——脱战零代价（走开即可），战斗张力来自
  Boss 数值而非机制；
- **DM 纯洁性不设防**：world 三择由 Agent 自由抉择，若 Agent（角色扮演中）
  刻意放水或猛攻，引擎不修正——DM 的性格即地牢的性格，这是产品语义；
- **平衡未经人类玩家实测**：盲测只有两种贪心脚本，真机体感待用户反馈
  （大富翁教训：真机会暴露脚本测不出的问题）；
- **单局 state 上限**：三层满探索实测 <1KB，但「更深层/更大网格」的未来
  扩展须重估 64KB（揭示层弃置纪律是前提）；
- **跨局元成长不存在**：每局独立（新会话新 seed），图鉴/解锁属评估
  Phase 1+ 的新持久面范畴。

## 补记：视图反馈层（2026-10-16 用户需求，同日二次迭代）

需求源：「攻击等交互事件应该弹出显眼的提示，在 PC 上支持 WASD 和方向键以及
JKL 绑定操作」。纯视图层单文件落法（引擎/桥协议/sessions 零改动——象棋将军
提示层同款纪律），与主体同文件 `builtin/dungeon-crawl.ts`：

- **事件提示栈（dc-toast-stack）**：每次局面真变化把该手 summary 以浮层弹出，
  分级渲染（遭遇/陷阱/倒下 → danger 红框、通关 → finale 金框）、栈内至多
  3 条、2.8s 淡出。指纹差分（坐标/HP/药水/金币/攻防/回合/终局/接战怪 HP 的
  投影串）判定「真变化」——1s 轮询重复下发不弹、首帧不弹。
- **飘字伤害（dc-float-num）**：HP 差分驱动——英雄受击红 / 怪物受创橙 /
  治疗绿 / 击杀 💀，按格位上浮 1.1s 消散（offsetLeft/offsetTop 相对定位锚
  board-wrap）。
- **PC 键盘**：WASD 与方向键 = 四向移动（同义键并存），J/K/L = 攻击/喝药/
  下楼——与按钮**共用同一合法面**（按钮 disabled 即按键静默：键盘不可能越过
  回合闸与合法性闸，非法动作根本不上行）；Ctrl/Alt/Meta 修饰键组合不劫持
  浏览器快捷键；方向键触发时 preventDefault 防页面滚动。按钮带键位角标
  （`.k` 角标），footer 写明绑定。
- **实现期自纠两笔（如实留档）**：① toastClassOf 初版「倒下→danger」先于
  「通关→finale」判定——胜利 summary 两词兼有（「炎魔君王倒下了…通关」），
  被误分级 danger；改为通关优先。② 视图上行初版是裸 `parent.postMessage`
  （井字棋先例），浏览器合法但 DOM 垫片测试无法注入（21 点用
  `window.parent` 的原因）；改 `window.parent.postMessage`，真机行为不变。

测试 +6（games-dungeon-crawl.spec 39→45）：静态标记 1 + 键盘绑定 3（WASD/
方向键上行、非法方向与修饰键静默 / J/K/L 合法面联动 / world 回合全键静默）+
提示与飘字 2（引擎真实 applyAction 载荷序列：首帧不弹、每手 summary 弹、
受创/受击/治疗三类飘字、重复轮询不弹；💀 与 danger/finale 分级）。DOM 垫片
真跑内联脚本（FakeElement + new Function——21 点坐席归属视图用例同款纪律）。
gates server-bundle 增 `dc-toast-stack` / `dc-float-num` 两 marker + 各自负
样本自证。

### 四次迭代：Boss 只生成一次（同日用户实弹反馈「Boss 应该只能被生成一次」）

用户在真机 agent-tavern 会话中观察到多个炎魔君王。根因：revealAround 的初版
条件 `cls === 'monster' → depth === MAX_DEPTH ? bossMonster() : ...` 把**第 3 层
所有怪物格**全放成了 Boss（受 `!isStairs` 守卫，石阶上反而没有 Boss）——满层
炎魔君王，且杀路径上任意一只即触发通关（heroAttack 按 `monster.boss && depth===3`
判胜），「石阶巢穴」形同虚设。修复：Boss 放置改为 `isStairs && depth === 3`
独立分支（石阶格不吃常规内容，1/2 层石阶恒干净的既有语义不变）——**恰一只、
只在最深层的石阶格**。

测试加强（e2e 通关用例此前「为错因通过」——杀的是路径上的假 Boss）：seed 3
通关路径改为先走到石阶邻格（BFS 路径避开石阶格本身，取证前不触发遭遇）断言
Boss 唯一性（揭示范围内 boss 恰一只、在石阶格、`toMatchObject({boss:true,
name:'炎魔君王'})`），再踏入石阶遭遇（先手交 world）战斗到终局。seed 1 阵亡
路径复核仍成立（d3 路径怪物变弱后英雄仍阵亡——冻结不变）。修复后 seed 3 实测
通关手数与英雄状态不变量级（路径战更轻、Boss 战同款）。

### 三次迭代：提示栈移位（同日用户反馈「提示多的时候挡住了游戏画面」）

初版提示栈 `position:absolute` 浮在棋盘上沿——多条提示堆叠时盖住顶部两三行
格子。移位为**常规文档流块**：`#dc-toast-stack` 移出 `#board-wrap`，置于棋盘
与操作栏之间（`align-items:stretch` 占满面板宽、`margin-top:8px`），提示再多
也只是向下推操作栏，永不遮挡棋盘；飘字（dc-float-num）仍锚定格位在棋盘内
（1.1s 即散、按格位出现，不构成遮挡）。测试 +1（games-dungeon-crawl.spec
45→46）：DOM 顺序断言（board-wrap 先闭合 → toast 独立块 → controls）+ CSS
规则断言（`#dc-toast-stack` 不得回到 absolute）——「不遮棋盘」钉成可执行
契约。
