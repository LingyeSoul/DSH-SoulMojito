# 禁用投降 + 用户投降按钮 + 终局保留盘面（提案 0018 §16）

> 日期：2026-10-14。需求源（同日两条用户反馈）：①「添加禁用投降（显示在管理面板中）
> 和用户投降按钮，渲染到游戏显示区」；②「游戏结束时……应该显示游戏盘面，结束游戏
> 很突兀」。设计契约：提案 0018（§3.2 保留动作 resign 的运行时处理、§4.2 工具面、
> 本次新增 §16 补记）。本文记录策略/语义/UI 三层落法与边界。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 回答 |
|---|---|
| 所有者 | `tavern-store` state（`gamesDisableResign`）+ `src/games/service.ts`（拒绝闸）+ `src/games/sessions.ts`（出回合投降语义）+ `client/main.js`（按钮/开关/终局盘面）——四层同属本特性 |
| 唯一事实来源 | 开关以 `state.json` 的 `gamesDisableResign` 为准（默认 false）；服务层逐次读取（TavernStore 内存态）——面板翻转即时生效 |
| 持久态及理由 | 一个布尔进既有 state.json（用户偏好，跨重启保留）；无新文件 |
| 临时态 | 投降按钮的两步确认 armed 态（客户端 useState，4s 自动复位）——重启即失可接受 |
| 外部依赖 | 零新增（宿主 Button 原语已用于面板；POST games/action 既有路由） |
| 注册入口 | state 补丁路由接受新键；面板「游戏」分区新增 toggle；GameSurface 新增按钮；无新路由/工具/分区 |
| 删除路径 | 删 state 字段（归一化按 `=== true` 宽容，旧值静默忽略）+ 面板 toggle + 按钮块 + 服务闸 + CSS 两条 + 测试/gates 断言——零迁移 |
| 兼容对象 | 会话文件零变化；旧客户端（不知新键）行为不变（服务端门照常兜底）；工具面形状零变化（resign 失败时给结构化中文报文） |

## 落法（四层）

1. **策略层**：`gamesDisableResign`（默认 false = 投降可用，与既有行为一致）。服务层
   `assertResignAllowed` 在 humanAction 与 agentMove 两个入口一致拒绝
   `{type:'resign'}`（400 + 「投降已被禁用（设置面板「游戏」分区可重新启用）」）——
   按钮隐藏只是 UI 面，服务端门是权威（旧客户端/工具面/直连 HTTP 都不能绕过）。
   策略以回调注入（`GamesServiceOptions.resignAllowed`），逐次读取内存态：无缓存、
   无写穿、翻转即时生效。
2. **语义层（人类出回合投降）**：`resign` 是会话级终止而非行棋动作——人类可在任意
   时刻投降（含 AI 回合；棋盘上的按钮随时可用），actor 重锚为人类角色、
   describe/winner 随之一致；Agent 的 resign 仍受回合纪律约束（它只在自己回合动作）。
   配套：动作形状校验（JSON 对象/type/尺寸）前移到回合判定之前——例外判定需要先
   知道 action.type，且畸形动作报 invalid 比报 turn 更准确。
3. **UI 层（零新网络面）**：`GameSurface`（棋盘 iframe 之下）新增投降按钮——两步
   点击确认（armed 态 4s 自动复位）、「禁用投降」开启时整体不渲染；上行复用与棋子
   同一条 postAction 路径（ref 持有最新闭包，message 效应不锁旧 session 态）。按钮
   出现在全部三个对局面（ST 内联 / 面板会话卡 / 右栏 tab——共用 GameSurface）；
   面板「游戏」分区新增「禁用投降」toggle（POST state 补丁 + bootstrap 刷新）。
4. **终局盘面（用户反馈 ②）**：终局不再只剩一行结果文案——TavernGameBoard 与
   GamesPanel 的 finished 分支同样渲染 GameSurface（视图自带终局覆盖层、点击已
   禁用），结果行在盘面之下；`useChatGameSessions` 的补拉过滤放宽为「未终局 **或
   本次挂载见证过的已终局**」（`sessionStatesRef` 见证集）——最后一手若由对方走出，
   旧的过滤会把它停在倒数第二手；挂载时已终局的旧对局不补拉（「不翻旧账」不变）。

## 语义边界（如实标注）

- 「禁用投降」是全局开关、即时生效：进行中的对局同样受影响（Agent 若在等待中，
  人类按钮消失；Agent 的 resign 调用得到清晰拒绝并继续对局）。
- 出回合投降改变了 §4.1 的「actor 恒等于当前回合」表述——例外只覆盖
  `resign ∧ owner==='human'`，其余动作与 Agent 面规则不变（sessions.ts 文件头已
  回写该例外）。
- 终局盘面的「见证集」判据依赖本次挂载见过该会话活跃：挂载时已终局的旧对局仍只出
  结果行（不翻旧账），刷新页面后与既有纪律一致。
- 两步确认是客户端防误触，不是权限门——服务端门只认 `gamesDisableResign`。

## 测试与 gates（基线对账随实现提交）

- `games-service.spec.ts`：+1 describe（人类出回合投降锚定 actor/winner/describe；
  Agent resign 仍受回合纪律；禁用门两入口一致 + 翻转即时生效 + 普通动作不受影响；
  形状校验前移的出回合畸形动作报 invalid）。
- `games-client.spec.ts`：+1 用例（投降按钮 marker/两步确认/设置隐藏/双表 i18n/
  终局面两处同款/见证集判据 + 负样本）；i18n 键集合补 `games.resign` 与
  `games.resignConfirm`。
- `store.spec.ts`：默认值对账加 `gamesDisableResign: false`。
- gates：server-bundle 增 `gamesDisableResign`/`assertResignAllowed` marker + 负样本；
  frontend-runtime 增四类 marker（按钮上行/样式类/设置键/见证集判据）+ 各自负样本。
- 实测对账：本特性净增 5（games-service 的投降 describe +4、games-client 的
  投降/终局盘面用例 +1；store.spec 为既有默认值断言内改，不计增）。连同同批的
  自动续弈特性与工具面修订，全仓 98 文件 1466 过 +1 跳（0.6.2 基线）→ 99 文件
  1484 过 +1 跳；15 gates 全 PASS，`pnpm run check` 连续两次 exit 0。
