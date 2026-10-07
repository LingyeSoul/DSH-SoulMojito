# 提案 0011：Rewrite with Feedback（带意见重写）— dsh-tavern 功能复刻

> 状态：已实现。日期：2026-10-07。参照物：`flizzywine/dsh-tavern`（AGPL-3.0）的**公开功能文档**
> （README「带意见重写」、`docs/feature-inventory.md` B07：写上哪里要改，只重写这一轮，比反复
> 抽卡可控；意见可留空=直接重写），按本仓库 clean-room 教义从行为规格重实现，不复制其源码。
> 实施期间禁止阅读该仓库源码。

## 1. 范围

对当前轮回复：一键重写，或填写意见（如「保留事件，但减少旁白解释」）后按意见重写。
意见是一次性生成指引，不作为楼层落盘；重写结果作为新 swipe 追加，可左右切换（既有机制）。

| 能力 | 去向 |
|---|---|
| `feedback` 请求参数（regenerate 专用） | `generate()` body 解析 + 校验（mode!=='regenerate' 时 400） |
| 意见注入（瞬态，不落盘） | `runGeneration` regenerate 分支：systemParts 追加 rewrite 指令块 |
| swipe 元数据回显 | `swipe_info[].extra.feedback` 记录本次意见，面板在变体上显示 |
| Guide 协同 | 重写请求同样携带 guides 块（提案 0009） |
| 面板入口 | 末条回复「带意见重写」：意见输入（可空）→ regenerate with feedback |

**明确裁剪**（不做，理由）：
- **任意历史节点重写**：只作用于当前轮（最后一条楼层），对齐 flizzywine 的边界声明
  （「不描述为任意历史分支」）。
- **AgentTavern 聊天的重写按钮**：重试/重掷语义归宿主 AgentLoop（提案 0004）；用户口头要求
  agent 重写上一条是 AgentTavern 的自然能力，不做插件侧按钮。

**已文档化的适配偏差**：
1. 意见 ≤1000 字符（本地防滥用决策）；空串等价于普通 regenerate（不加注入块）。
2. 意见块位于 system 段末尾（guides 块之后），格式：
   `Rewrite directive for this reply (user feedback; the previous reply is being rewritten): <text>`。
   「保留满意部分」靠指令措辞实现（提示词要求保留用户未点名的问题），与 flizzywine 同思路。
3. `swipe_info[].extra.feedback` 与 `extra.api/model/reasoning` 并列持久化，导出纯对话不受影响。

## 2. 包结构

```
packages/plugin/src/rewrite.ts            纯逻辑：feedback 校验 + 注入块格式化（可单测）
packages/plugin/src/index.ts              generate() feedback 解析 + runGeneration 注入点
packages/plugin/tests/tavern-rewrite.spec.ts  参数校验 / 注入与不落盘断言 / swipe 元数据单测
```

## 3. 接线

1. `generate()`：`const feedback = mode === 'regenerate' ? optionalString(body.feedback) : undefined`，
   非空时 trim ≤1000；非 regenerate 携带 feedback → 抛错（走现有 error 事件通道）。
2. `runGeneration`：`mode==='regenerate'` 且 feedback 非空时，在 systemParts 收集处追加
   `formatRewriteBlock(feedback)`；保存时 `swipe_info` 末项 `extra` 写入 `feedback`。
3. 面板：末条助手消息操作区现有重掷入口旁增加「带意见重写」（意见输入可空提交）。

## 4. 语义对照要点

- 意见**不是楼层**：聊天记录中不出现意见文本，仅存活于本次请求 + swipe 元数据。
- 用户消息不被重写触碰；重写只弹旧助手回复（既有 `regenerated` pop 语义）。
- 带 guides 的局：重写同样受 Guide 约束（flizzywine 语义「之后每轮正文、候选、变量结算都参考」）。
