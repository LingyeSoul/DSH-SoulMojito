# 提示词查看器 + 世界书激活追踪（A-6）

> 日期：2026-10-11。来源：[JSR/LWB 竞品参考](../docs/exploration/2026-10-11-jsr-lwb-reference.md)
> §2.5/§4 的 A-6 建议（JSR 的 PromptViewer + wi_tracer 世界书激活追踪；JSR 为
> PolyForm NonCommercial——只复刻可观察语义，重新实现，零代码拷贝）。
> 落点：`packages/plugin/src/prompt-viewer.ts`（新）、`packages/plugin/src/index.ts`
> （runGeneration 记录点 + GET prompts 路由）、`packages/plugin/client/main.js`
> （面板「提示词」分区）、`packages/tavern-lore/src/{engine,types}.ts`（加法式
> 补齐 viaRecursion / 成功掷值）。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/src/prompt-viewer.ts`（缓冲与查询）；记录点归 runGeneration |
| 唯一事实来源 | 进程内环形缓冲（模块级单例）——「实发请求」以 pre-llm dispatch 之后的对象为唯一权威，与落盘元数据（swipe_info/extra）同源同理 |
| 持久态 | **无**。调试观察数据不落盘（见「内存态取舍」） |
| 临时态 | 全部：每聊天最近 10 条、总量 50 条，重启即失——可接受，同 Mod 日志查看器的环形缓冲取舍 |
| 外部依赖 | 无新外部依赖。只复用 runGeneration 既有对象与 ctx.logger |
| 注册入口 | HTTP `GET /api/dsh-tavern/prompts`（handleApi，memory/maintenance 路由之后）；面板第 16 个分区 `id: 'prompts'`（client/main.js registerPanelSection） |
| 删除路径 | 删 prompt-viewer.ts + index.ts 三处接线（import / recordPromptView 调用 / prompts 路由）+ main.js 分区与 locale 键 + 本决策文档；lore 包的两个加法字段（viaRecursion / 成功掷值）独立成立可保留 |
| 兼容对象 | lore 包 `ActivationResult` 消费者：新字段全部可选加法式，既有测试零改动通过；旧客户端不读 prompts 路由；README 测试基线数字不动 |

## 记录点纪律（看到即实发）

**记录点在 pre-llm hook 全部跑完之后、`llm.stream` 之前**（index.ts，
`hookedLlmRequest` 提取 usedProvider/usedModel 之后、`beginStreamEpoch()` 之前）。
mod 经 pre-llm 改写 system/messages/params 后，记录的是**改写后的实发形状**——
与「pre-llm 后的实参是落盘元数据的唯一权威」同一条纪律（P0 决策遗留问题的
闭环位，decisions/2026-10-10-mod-review-fixes.md）。

三个刻意选择：

1. **纯观察、不反噬生成**：`recordPromptView` 整体 try/catch，任何失败吞掉 +
   宿主日志一行（`dsh-tavern: prompt-viewer record failed: …`），生成路径零感知
   （stream-delta / Mod 事件面同款纪律）。**loreTrace 的提取
   （buildLoreTrace）也在这个 try 内完成**——记录路径的任何一环（含 trace
   构建）都不允许击穿生成。测试用故障注入验证：注入抛错后生成照常 saved。
2. **记录的是脱壳纯文本**：messages 存 `{role, content}` 文本形态——content 数组
   里的 text 块拼接，非文本块记占位标记（`[image_url block]`），非对象内容记
   `[non-text content]`。记录面不承载二进制。
3. **params 无密钥**：llm.stream 走宿主路由，实发 params 本就只有
   provider/model/reasoningEffort/temperature/maxTokens（index.ts llmRequest
   构造点核实，不含密钥类字段）。但 pre-llm hook 可注入任意键——防御性丢弃
   密钥样键名（/secret|password|authorization|credential|apikey/i）+ 非原始值
   字符串化，记录面永不成为密钥泄漏面。测试覆盖该净化。

## 数据形状

```ts
PromptViewerRecord = {
  at: string            // ISO 时间戳
  seq: number           // 进程内单调序号（同毫秒定序 + 倒序依据）
  character, chatId, mode
  system: string | undefined   // 无 system 段时不带键（与请求的条件展开语义一致）
  messages: { role, content }[]  // 脱壳纯文本（见上）
  params: Record<string, unknown>  // 净化后实参
  promptTokens: number  // system + 全部消息的字符近似估算
  loreTrace: {
    entries: { world, uid, name(entry.comment), matchedKeys, position, depth,
               order, reason, constant,
               probability?: { use, value, roll? },   // <100 且参与掷骰的条目
               viaRecursion? }[]                      // RECURSION 轮激活的条目
    scanRounds, recursionRounds, budgetUsed, budgetLimit
  } | undefined
}
```

- **环形缓冲**：每聊天保留最近 `PROMPT_VIEWER_PER_CHAT = 10` 条（淘汰同 chatId
  最旧）、总量封顶 `PROMPT_VIEWER_TOTAL = 50`（FIFO 淘汰全局最旧）。两级上限
  都有测试。
- **HTTP**：`GET /api/dsh-tavern/prompts?character&chatId`（过滤可选，任一或
  组合），缺省全量，按 seq 降序（最新在前）；`{ok, records}`，无记录时空数组。
- **token 估算**：`Math.max(1, ceil(len/4))`——与 agent-tavern/agent.ts 的
  approximateTokens 同公式（runGeneration 的 countTokens 用 len/3.5，两者同为
  仓库既有「字符长度近似」口径，面板取 agent 侧同款）。

## loreTrace：实得字段与边界

字段以 lore 包 `ActivationResult` 实际可得为准（engine.ts/types.ts）：

- **直接可得**：world（book 标识）、uid、name（entry.comment/Memo）、matchedKeys
  （命中的**主键**）、position（WI_POSITION 原值，面板映射标签）、depth、order、
  reason（constant / primary-key / primary-and-secondary / sticky / decorator）、
  constant、概率（useProbability + probability + diagnostics.probabilityRoll）、
  scanRounds / recursionRounds / budgetUsed / budgetLimit。
- **本轮补齐（lore 包加法式改动，既有测试零改动通过）**：
  1. `ActivatedEntry.viaRecursion`——是否在 RECURSION 轮激活（activatedMeta 记
     `state === 'RECURSION'`）。
  2. `diagnostics.probabilityRoll` 成功路径也记录——原实现只对**未过概率**的
     条目记掷值，成功条目的概率不可审计；「参与掷骰时」的文档语义本就含成功。
- **边界（引擎不追踪，如实记录）**：
  - **递归来源链**不可得：只记「经递归轮激活」（viaRecursion），不记「被哪条
    条目的内容触发」——引擎的递归是共享缓冲不是图遍历。追溯来源需在引擎里
    记 per-entry 激活依赖，属 v2。
  - **未激活候选的诊断**（概率未过、预算淘汰、副键不满足等 SkipReason 全集）
    lore 包 diagnostics 可得，v1 面板只展示已激活条目——「激活轨迹」以实际进
    prompt 的条目为准，未激活诊断留 v2。
  - loreTrace 记录的是**激活事实**（引擎输出），WI 文本后续还要过 WORLD_INFO
    regex / EJS 模板渲染——最终注入文本以同轮记录的 system/messages 为准。

## 内存态取舍（v1 不落盘）

调试观察数据落盘有三个反例：体积（50 条全量 prompt 可达 MB 级）、隐私（完整
角色卡 + 聊天 + persona 拼进单文件，比聊天记录本身更敏感）、时效（调试场景
只关心「刚刚那轮发了什么」）。与 Mod 日志查看器的客户端环形缓冲同款取舍：
**重启即失是特性不是缺陷**。需要跨会话比对时导出聊天（activatedLore 已按
entryId 落在消息 extra 里，长期事实不丢）。

## 否决项（v2 候选）

- **preset 纯化重放**（JSR 的 replay 面）：工程量大（需要宿主请求回放通道或
  插件自带重放客户端）且与 DSH 宿主 LLM 路由的请求归因（request journal /
  计费）打架——查看器先做「看」，「重放」等真实调试需求出现再立项。
- **AgentTavern 覆盖**：AgentTavern 走宿主 AgentLoop，插件看不到完整请求
  （上下文是宿主 projection）——与 stream-delta 同款 v1 边界，面板 hint 如实
  标注。
- **未激活候选全量诊断 / 递归来源链**：见上节边界。
- **SSE 推送面板刷新**：50 条环形缓冲 + 手动刷新按钮足够，轮询/推送不值当。

## 测试

`packages/plugin/tests/prompt-viewer.spec.ts`（13 项）：

- 环形缓冲：每聊天 10（FIFO 保新）、总量 50（跨聊天全局 FIFO）、脱壳占位与
  params 净化、过滤与倒序；
- loreTrace：伪造世界书五例（主键 / 副键 AND_ANY / 概率 50 注入 rng / 常驻 /
  delayUntilRecursion 递归）逐字段对齐；默认条目不带概率块；
- 接线：pre-llm 改写后记录的是改写后形状（system + provider/model）；空总线
  基线（system undefined + 选择器模型）；记录器注入抛错生成照常 saved + 宿主
  日志一行；
- 路由：无记录空数组、倒序、形状、character+chatId 组合过滤；
- 客户端：main.js 分区注册 / prompts fetch / zh+en locale 键 marker（带闭合
  引号的 marker + 负样本自测——不同 id 不得把 marker 当子串误命中）。

回归：`tavern-generation-hooks.spec.ts`（五相位接线不受记录点影响）与
`tavern-lore/tests/engine.spec.ts`（viaRecursion / 成功掷值是加法式，既有断言
零改动通过）。
