# 人类落子自动续弈：Agent 未 wait 时的插件侧唤起（提案 0018 §15）

> 日期：2026-10-14。需求源：用户——「当 agent 没有调用 wait 而是停止运行后，用户
> 操作完游戏由插件自动触发 agent 继续」。设计契约与先行件：
> [提案 0018](../docs/proposals/0018-agent-game-bridge.md)（§4.2 工具面、§10 wait
> 修订、本次新增 §15 补记）、[决策 2026-10-13](2026-10-13-agent-game-bridge.md)
> （§7-4 的「宿主无 seam」论断——本次以插件侧 followup 面落地，与 §10 的工具内
> 挂起面合成完整的双向控制流）。本文记录查证、落法、防重语义与边界。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 回答 |
|---|---|
| 所有者 | `src/games/wake.ts`（投递）+ `src/games/handle.ts`（跨 bundle 等待登记）+ `src/games/service.ts`（触发出口）+ `index.ts`（接线：绑定反查与宿主 agents）——四条同属本特性 |
| 唯一事实来源 | 对局状态仍在会话 JSON；「谁在等待」以 handle.ts 的 globalThis 登记表为准（进程内临时态，见下） |
| 持久态及理由 | 零新增持久态——通知是事件语义（一次人类动作一条），不需要意图持久化/重试账本（与 agent-novel 的调度语义刻意不同） |
| 临时态 | 等待登记表（globalThis Map，跨 bundle 互见）——重启即失可接受：丢失只意味着一次人类动作少一次自动唤起，懒段 + 下次消息兜底 |
| 外部依赖 | 既有宿主面：`ctx.agents.get(id)`、`Agent.followup(message)`（agent-novel 驱动已在生产使用）；零新宿主能力、零新网络面 |
| 注册入口 | `openGamesService({ onHumanAction })` 选项（index.ts 接线）；无新工具/路由/面板分区 |
| 删除路径 | 删 wake.ts + handle.ts 的登记表 + service 的 onHumanAction 选项与调用 + index.ts 接线 + games-autowake.spec + gates 两条 marker——零数据迁移 |
| 兼容对象 | 会话文件零变化；工具/HTTP 形状零变化；旧宿主（无 agents 面）逐级降级为懒段兜底（与本次之前行为一致） |

## 查证（为什么现在能做）

- `@deepseek-ai/dsh-agent` 的 `Agent` 接口（runtime-types.d.ts:186-210）暴露
  `send/followup/steer/inject` 四个投递面；`followup` = 「Queue an ordinary
  follow-up turn and wake the driver」——**宿主有服务端唤醒面**，§7-4 的原始论断
  只在「等宿主推游戏事件」的姿势下成立。
- `agent-novel/driver.ts` 是既有先例：同一 `followup(hostPluginMessageSource({form:
  'notice'}))` 机制 + 结构化宿主面逐属性降级（agents.get 缺失/抛错/undefined 三态）
  + 插件来源绝不伪装用户消息（v0/v4 source 形状由 bind 的 hostPluginMessageSource
  分支）。
- 插件侧绑定：`state.sessionBindings` 反查 character+chatId → agentId（index.ts 已
  有 store 访问）；`ctx.agents` 已在 index.ts 的 inject 面内。

## 落法（四层）

1. **等待登记**（handle.ts）：`beginGameWait(sessionId)` 返回注销器 / `gameWaiters
   (sessionId)` 计数，锚 `globalThis[Symbol.for('dsh-tavern:games-waiters')]`（跨
   bundle 互见契约 key）。game_wait 在挂起循环外套 try/finally 登记/注销（返回、
   超时、中止、抛错四条路径统一释放）。
2. **投递**（wake.ts）：`wakeAgentOnHumanMove(host, session)`——先判等待中（>0 直接
   返回 false），再反查绑定、取 live agent、`followup` 通知。通知 id
   `game-notice-<sessionId>-<moveCount>`（幂等锚）；source = 插件来源 + form
   'notice'（v4 producer-owned kind / v0-v3 兼容形状）；文本 token 经济（「自动游戏
   通知（非用户消息）」+ 游戏名 + sessionId，终局变体带结果与收尾指引）。
3. **触发**（service.ts）：`humanAction` 成功出口回调 `onHumanAction`；被拒动作不
   触发；回调抛错只记日志（落子回执不受影响）。
4. **接线**（index.ts）：`bindingOf` 扫 sessionBindings（只认 agent-tavern 且非
   群聊），`agents: ctx.agents`，logger 落 ctx.logger。

## 防重语义（不产生重复/陈旧回合）

- **等待中不投递**：有 gameWaiters 时该手已由工具内唤醒覆盖——重复投递会让等待
  回合结束后多出一个陈旧通知回合（这是本特性最易踩的坑，单独测试钉死）。
- **一次动作一条通知**：幂等 id + 触发点唯一（humanAction 成功出口）。
- **被拒动作天然无通知**：409/非法动作在 service 层早退。
- **不重试**：投递失败（冷会话/followup 抛错）静默降级——事件语义，错过由懒段 +
  下次消息唤起覆盖（对账：agent-novel 的持久意图/重试是为「无人触发的连续调度」
  设计，本特性每次触发都有人类动作在场，不需要）。

## 语义边界（如实标注）

- 用户停止生成（cancel 清队）可能丢弃已排队的通知回合——下次人类落子/消息补上。
- 同一聊天多 AgentTavern 会话绑定时只唤起首个（v1：一个聊天一个对局一个会话）。
- 群聊绑定不唤起（懒段对群聊本就不注入游戏段，唤醒了也没局面上下文）。
- 冷会话（agent 不在宿主注册表）不唤起——用户不在场看棋盘时也无需回合。

## 测试与 gates（基线对账随实现提交）

- `games-autowake.spec.ts`（新，8 例）：投递形状（id/role/插件来源/form/文本自足）/
  等待中不投递与注销后恢复/会话隔离/无绑定静默/四级降级（agents 缺失、get 抛错、
  get undefined、句柄无 followup）/反查与 followup 抛错只记日志/终局文本/旧宿主
  source 形状。
- `games-service.spec.ts`：+1 describe（回调收到摘要、被拒与 Agent 落子不回调、
  回调抛错不回退落子）。
- `games-tools.spec.ts`：等待登记断言（挂起=1、返回/超时/中止=0）。
- gates：server-bundle 增 `dsh-tavern:games-waiters` 与 `game-notice-` marker +
  负样本自测；frontend 面无改动。
- 实测对账：本特性净增 9（games-autowake.spec 新文件 +8、games-service 的回调
  describe +1）；连同同批的投降特性与工具面修订，全仓 98 文件 1466 过 +1 跳
  （0.6.2 基线）→ 99 文件 1484 过 +1 跳；15 gates 全 PASS，`pnpm run check`
  连续两次 exit 0，dist 六件 + version stamp 重建（v0.6.3）。
