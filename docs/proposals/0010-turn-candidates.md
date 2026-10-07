# 提案 0010：Turn Candidates（行动候选生成）— dsh-tavern 功能复刻

> 状态：已实现。日期：2026-10-07。参照物：`flizzywine/dsh-tavern`（AGPL-3.0）的**公开功能文档**
> （README「候选项」、`docs/feature-inventory.md` B05/B06：独立生成行动候选与场景变化；点击候选
> 填入输入框，可修改后发送；可带意见重新生成），按本仓库 clean-room 教义从行为规格重实现，
> 不复制其源码。实施期间禁止阅读该仓库源码。

## 1. 范围

候选生成与正文生成解耦：一个独立轻量请求，基于近期历史 + 角色 + Guide 产出 3–6 个
「人物行动 / 场景变化」候选；面板点击填入输入框（可改再发，不自动执行）；可带意见重新生成。

| 能力 | 去向 |
|---|---|
| 候选提示词构造（近期历史 + 角色摘要 + guides + 可选反馈） | 新模块 `packages/plugin/src/candidates.ts`（纯函数，可单测） |
| 候选请求执行（非流式收集 + JSON 解析 + 校验） | `candidates.ts`，复用 `ctx.llm.stream`；模型选择复用现有 choice 逻辑的简化版 |
| 结果存储（面板渲染用） | `chat.header.chat_metadata.candidates = { items, generatedAt, feedback? }`，随聊天持久化 |
| API | `POST candidates`（body: character/chatId/feedback?/revision），返回候选 + 新 revision |
| 面板入口 | 候选面板：生成 / 带意见重新生成 / 点击填入输入框 |

**明确裁剪**（不做，理由）：
- **每轮自动后台生成**（flizzywine 的后台任务自动跑候选）：v1 手动触发。自动后台需要宿主
  `whenIdle` followup 与 v4 会话准入耦合，留待独立提案。
- **AgentTavern 聊天的候选**：AgentTavern 不新增第二条生成循环（提案 0004 红线），插件对
  agent-tavern 绑定的聊天不暴露候选入口；「给我几个行动选项」由 agent 本体承担。
- 候选不经过正则 / 模板 / 宏链路：独立请求，无落盘副作用（除 candidates 元数据本身）。

**已文档化的适配偏差**：
1. 候选数量 3–6、单项 ≤200 字符、历史窗口最近 10 条楼层（flizzywine 未公开参数）。
2. 候选请求携带 guides 块（提案 0009），格式与正文注入一致——对齐 flizzywine「候选也参考 Guide」。
3. 模型沿用当前聊天生效的 provider/model 选择；生成失败返回结构化错误，不落聊天。
4. 解析容错：模型输出提取首个 JSON 数组；非 `{kind,text}` 形状的字符串项按 `kind:'action'` 兜底；
   超额截断到 6，空结果报错让用户重试。

## 2. 包结构

```
packages/plugin/src/candidates.ts           buildCandidateRequest / collectCandidateText /
                                           parseCandidates / 存储读写 helpers
packages/plugin/src/index.ts                POST candidates 路由（generate 附近）
packages/plugin/tests/tavern-candidates.spec.ts  提示词构造 / 解析容错 / 反馈重生成 / 持久化单测
```

## 3. 接线

1. `POST candidates`：校验 binding 为 ST 架构（`assertStGenerationBinding` 同款检查）；revision CAS；
   读 chat + character + guides → `buildCandidateRequest`（feedback 时携带上一轮候选 + 用户意见，
   要求据此修订）→ `ctx.llm.stream` 收集 → `parseCandidates` → 写 `chat_metadata.candidates` →
   `saveChat` → 返回 `{ items, generatedAt, revision }`。
2. 面板：候选区默认折叠，展示当前 `chat_metadata.candidates`；「生成候选」按钮调 POST；
   候选项点击 → 填入输入框（复用现有输入态）；「带意见重新生成」携带反馈文本。

## 4. 语义对照要点

- 候选是**建议非指令**：面板语义是「填入输入框」，用户可修改后发送；与 flizzywine 一致，
  不存在「自动执行候选」路径。
- `feedback` 存入 candidates 元数据供面板回显「上次按什么意见生成」；不写入任何楼层。
- 候选生成失败不影响聊天状态（revision 不变），面板显示错误并允许重试。
