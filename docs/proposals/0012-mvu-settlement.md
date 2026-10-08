# 提案 0012：MVU 后台变量结算 + 回执 + 固定状态栏 — dsh-tavern 功能复刻（设计）

> 状态：P1-P3 已实现（P1:61871df，P2:ca66f44）。日期：2026-10-07。参照物：`flizzywine/dsh-tavern`（AGPL-3.0）
> 公开功能文档（README「更稳」「人物卡转 MVU 版」、feature-inventory D02/D03/D04）。
> clean-room：只依据行为规格，实施时禁止阅读其源码。

## 1. 目标行为（从公开文档归纳）

1. 前台正文不再输出状态栏；变量由**后台按规则结算**（卡内 MVU 脚本/规则驱动）。
2. 每轮正文下方附**变量回执**：变更前后值、原因、脚本联动、失败项；区分已更新/未变化/
   部分成功/过期/中断。
3. 结算失败**可单独重试**，不要求重写满意的正文。
4. 状态栏由**固定模板按变量渲染**，常驻右侧面板，不随正文流式生成——结构上不可能掉格式。

## 2. 本仓库落点（分层设计）

| 层 | 决策 | 依赖 |
|---|---|---|
| 结算执行器 | 复用提案 0008 的 template runtime（EJS/变量 API 已具备）+ `tavern-script` 执行卡内 MVU 结算脚本；结算输入=本轮正文+当前变量快照，输出=变量补丁+回执事件 | 0008、tavern-script |
| 触发链路（ST） | `runGeneration` 保存正文后异步触发结算（不阻塞流式返回）；结果写 `chat_metadata.mvu.receipts[turn]` | — |
| 触发链路（AgentTavern） | 不新增生成循环：结算器以**工具**形态暴露（`tavern_variable_settle`），由 agent 在楼层内调用；回执事件进 durable events | 0004 红线 |
| 状态栏渲染 | 后端把变量快照交给 `tavern-template` 渲染固定模板 → 面板右侧常驻 HTML 面板（FrontendFrame 同款沙箱） | 0008、client |
| 重试 | 回执失败项暴露 `POST mvu/retry`（ST）/ 工具重调（AgentTavern），只重跑结算不动正文 | — |
| 转 MVU 版 | 卡片工作台起始任务（提案 0013）「card-to-mvu」：从卡内正则/状态栏块反推变量结构与模板 | 0013 |

## 3. 阶段划分

- **P1**：回执数据结构 + ST 链路结算执行器 + 状态栏渲染（无卡可结算时面板隐藏）。
- **P2**：失败重试 + AgentTavern 工具形态 + durable events 回执投影。
- **P3**：card-to-mvu 转换任务（并入 0013 工作台）。

## 4. 明确裁剪

- 不复刻 flizzywine 的「后台模型结算」（用 LLM 结算变量）：本仓库用**确定性脚本结算**
  （卡内 MVU 规则本就是脚本语义），LLM 只在 card-to-mvu 转换时介入。理由：可重放、可单测、
  不产生每轮额外模型费用；与 flizzywine 的差异属于架构选择，需在用户文档标注。
- 姿势总结（posture-settlement 类 LLM 后台任务）不在本提案范围。

## 5. 实现补充（2026-10-08）：AgentTavern 显示面打通

P1-P3 落地时面板只挂在 `TavernView`（ST 表面）：AgentTavern 的 native conversation 由宿主
渲染，插件没有可插入正文区的 slot，`useNativeTavernTabFilter` 又把 Tavern tab 对非 ST 绑定
隐藏，因此 AgentTavern 会话里面板不可达；同时 `mvu/status` 的 `available` 只认
`chat_metadata.variables`，而 `tavern_variable_settle` 只写 chat 作用域 VariableStore
（`variable_set/patch/delete` 全族同理，从不写 chat 元数据），即使挂载也会整块隐藏。

补充落地（改的是显示面，不动结算语义）：

1. **变量源按绑定架构取**：`GET mvu/status` 对绑定到 `agent-tavern` 会话的聊天回读 chat 作用域
   VariableStore，按扁平点分名覆盖回嵌套树（`overlayScopedVariables`）后与 ST 共用同一份
   显示与 `statusTemplate` 渲染语义；ST 绑定或未绑定的聊天不回读，避免架构切换后的残留值
   污染 ST 变量。
2. **`available` 纳入回执**：`variables` 为空但存在回执（全项失败的结算）时面板仍可见可读。
3. **AgentTavern 挂载点**：MVU 面板以会话标题栏按钮弹出（`dt-mvu-slot`/`dt-mvu-pop`，
   点外关闭，与带意见重写同款弹出层模式），`TavernMvuStatus` 增 `embedded` 变体在无内容时
   给出空态提示；ST 仍走 `TavernView` 顶部内联面板。
4. `mvu-surface` gate 锁住上述挂载标记，防止「数据源修好、界面又不挂载」的回归。
