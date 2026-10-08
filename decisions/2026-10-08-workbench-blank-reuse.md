# 写卡工作台会话补占位：摘除宿主 blank 复用资格

日期：2026-10-08。状态：已实施。

## Problem

写卡工作台无法新建新会话：聊天侧「交给工作台」或面板自由工作台入口在已有
一个「打开过但未对话」的工作台会话时，第二次拉起必然报
`This CardWorkbench session is already bound to another chat.`。

根因链（复用 2026-08-16 决策查明的宿主行为）：

1. 宿主 `connectWorkspace` 按 `sessions.ids` 顺序复用工作区内第一个 blank 会话
   （判定：日志中从未出现 `turn/start`；marker 等插件事件不翻转 blank）；
2. `workbench-open` 桥此前有意「无占位 turn」（对齐 novel-open 形态），且工作台
   是纯对话式 preset、无 driver——用户开口前会话永远没有 `turn/start`，blank
   复用资格无界滞留；
3. 下一个 `openWorkbenchSession` 的 connect 落回这个已绑定旧来源的 blank 会话，
   撞上 fail-closed 换绑守卫，新建从此失败，直到用户在宿主手动删会话。

服务端修复落地后症状转为「点新建只会跳回旧会话」——第二层根因在客户端：
`openWorkbenchSession` 开头的幂等复用对所有入口生效，同来源身份（自由工作台
= 任意 sourceCharacter/sourceChatId 均空的绑定）已有存活会话时直接
`openSessionView` 短路，侧栏「+」与新建角色卡向导永远走不到 connect 新建
路径。

ST 会话没有此问题（激活即 `occupyHostSession`）；novel 靠 driver kickoff 的
真实 turn 把 blank 窗口压到秒级。工作台两头都没有。

## Decision

- **服务端主修复**：`handleWorkbenchOpenCommand` 在绑定写 + 幂等 marker +
  recompose 之后调用 `occupyHostSession(agent)`——新开的工作台会话立即写一对
  占位空转 turn（`turn/start {turn:1}` + `turn/end {turn:1, completed}`，推进
  live loop 轮次基线），摘除 blank 复用资格。机制、幂等与「宿主拒绝追加时仅
  失去保护不阻断激活」的降级语义与 ST 路径完全同款（决策 2026-08-16）。
- **已启动锁的同来源容忍**：锁在占位 turn 写入后会对「同来源幂等重发」误伤
  （客户端存量修复正是借该重发补占位），故镜像 AgentTavern 的
  `sameTavernBinding`：`sameWorkbenchSource`（同 architecture + 同来源身份）
  的重发放行，其余已启动会话仍锁死；换绑守卫不变。
- **客户端存量修复**：`repairBinding` 对 `card-workbench` 绑定不再只清客户端
  blank 镜像，改为重发同来源 `workbench-open` 命令（retain → command →
  release，与 ST 绑定修复同款），让服务端为旧版本打开的 blank 工作台会话补
  占位 turn 对；失败移除去重标记待重试。
- **客户端新建入口去短路**：`openWorkbenchSession` 增加 `{ fresh }` 选项跳过
  幂等复用查找；侧栏「+」按钮与新建角色卡向导（`launchWorkbench`）走
  `fresh: true` 每次新建，聊天侧「交给工作台」保留按来源身份复用（一聊一
  会话的设计不变）。多自由工作台并存时创建侧 rename 标题与面板
  WorkbenchList 标签按序号区分（第 2 个起带号，出卡后仍统一显示卡名），
  `nav.workbenchNew` 文案同步改为「新建」语义。

## Alternatives considered

- **占位扩展到 novel-open**：否——novel driver 以 `turn/end` 边沿记账轮次
  （§13），合成 turn/end 会污染进度核算；其 blank 窗口由 driver kickoff 收敛，
  无此缺陷形态。
- **blank 会话换绑新来源（服务端软恢复）**：否——与 2026-10-08 工作区决策的
  「已绑定会话拒绝换绑其他来源，防绑定被静默改写」冲突；正确路径是让绑定会话
  根本不进复用池。
- **客户端在 connect 后检测被劫持并重试**：否——宿主 connect 对同一 blank 会话
  会循环复用，重试死循环，且无法区分用户主动选择与劫持。

## Consequences

- 新开工作台会话日志多一对占位 turn；用户首条消息的轮号为 2
  （`findLast(turn/start)+1`，与 agent-loop 编号规则一致，v4 关系准入不破）。
- 升级时已存在的 blank 工作台会话由 PanelHost 启动清扫（及 TavernView 挂载）
  触发的 `repairBinding` 幂等补占位；清扫前的短窗口内仍可能撞换绑守卫，报错
  自愈于下次面板加载。
- 同来源重发对已占位/已对话会话都是无副作用幂等（marker 去重、绑定重写保留
  `createdCard`），宿主会话日志仅多一行 command lifecycle 控制面记录。
- 自由工作台可多开后，升级前遗留的 blank 会话完成 repairBinding 前的短窗口
  内点「+」仍会被宿主复用旧会话（同来源容忍放行，静默回到旧会话而非报错），
  下次面板加载修复后即恢复真新建；此降级窗口与占位修复共用同一条清扫路径。
