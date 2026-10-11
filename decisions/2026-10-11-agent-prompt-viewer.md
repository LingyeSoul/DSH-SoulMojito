# 提示词查看器 Agent 模式预注入面

> 日期：2026-10-11。来源：A-6 决策的 v2 否决项「AgentTavern 覆盖」提前落地
> （用户需求：Agent 模式下的预注入提示词查看）。
> 前置：[decisions/2026-10-11-prompt-viewer.md](2026-10-11-prompt-viewer.md)
> （环形缓冲/吞错纪律/净化纪律全部沿用）。
> 落点：`packages/plugin/src/agent-tavern/prompt-capture.ts`（新，pre-step 捕获）、
> `packages/plugin/src/agent-tavern/agent.ts`（section 读取面 + agent/request
> 记录点）、`packages/plugin/src/index.ts`（捕获监听注册）、
> `packages/plugin/src/prompt-viewer.ts`（agent 补充面字段）、
> `packages/plugin/client/main.js`（Agent 模式渲染 + locale）。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | prompt-viewer.ts 的环形缓冲仍是唯一存储与查询面；Agent 模式合成归 agent.ts 的 `recordAgentTavernPromptViewFor`（记录点在 agent/request 监听器内）；pre-step 捕获归 prompt-capture.ts |
| 唯一事实来源 | 「实发 params」以 agent/request waterfall 链尾（预设温度覆盖之后）的对象为唯一权威；「预注入 section 文本」以 agent.ts 的懒装载投影缓存为权威（与宿主装配回调读同一缓存——同源即所见）；「注入消息」以 pre-step 决策批次中 plugin source 的消息为权威 |
| 持久态 | **无**（沿用 A-6 内存态取舍：体积/隐私/时效三反例，重启即失是特性） |
| 临时态 | 环形缓冲（每聊天 10 / 总量 50）+ pre-step 捕获 Map（16 个 agent 上限，按插入序淘汰最旧） |
| 外部依赖 | 无新依赖。复用 bind 的 `isHostPluginMessageSource`、cross-bundle 的 mod section 快照、prompt-viewer 既有净化 |
| 注册入口 | 无新路由（复用 `GET /api/dsh-tavern/prompts`，mode='agent-tavern' 记录自然混入列表）；index.ts apply 在 `registerAgentTavernAnchor` **之后** prepend 注册捕获监听（后 prepend 者更外层——await next() 后看到含锚定提醒的最终批次） |
| 删除路径 | 删 prompt-capture.ts + agent.ts 的 `recordAgentTavernPromptViewFor` / `agentPromptSectionsFor` 与监听器内记录行 + index.ts 两行接线 + prompt-viewer.ts 的 agent 字段 + main.js 渲染分支与两个 locale 键 + 本决策文档 |
| 兼容对象 | PromptViewerRecord 消费者（面板 / prompts 路由）：agent 字段可选加法式，旧记录无该字段走原渲染路径；既有 prompt-viewer.spec 14 项零改动通过 |

## 为什么是「预注入面」而不是完整请求

AgentTavern 的 LLM 请求由宿主 AgentLoop 发出（2026-08-16 审计）：system 头由
宿主 `systemPrompt.assemble` 物化进会话 surface，messages 由
`session.deriveMessages` 投影；`agent/context` seam 宿主未实现（capabilities
探针 `contextProjection: false`），`agent/request` 类型上只允许改调用配置、
`agent/pre-step` 只暴露本步进入批次——**插件没有任何单点能看到宿主拼装后的
完整最终请求**。A-6 因此把 AgentTavern 整体排除在记录面外（v2 候选）。

本决策把边界从「不记录」改为「记录插件预注入面」：插件自己注入了什么，插件
最清楚。三个捕获面拼成一条诚实记录：

1. **systemPrompt section/context 装配文本**：apply 注册的五段
   （kernel -80 / preset -75 / facts -70 / guides -65 / script -64）+ mod
   section 快照（cross-bundle 注册表，读时与 agent-mount 挂载面同式
   `clampModSectionOrder` + `hostPromptSafe`）。读取走与宿主装配回调**同一批
   懒装载投影缓存**（`valueOf` 同步读缓存，不触发重装载）——记录文本即宿主
   装配回调返回的文本。五段与注册面的双向对账由测试锁死（新增注册必须同步
   `agentPromptSectionsFor` 读取表，反之亦然）。
2. **pre-step 注入消息**：index.ts 在 anchor 之后 prepend 注册的最外层监听，
   `await next()` 后按 `isHostPluginMessageSource` 过滤最终进入批次——锚定/
   开场提醒计入；用户真实消息（source.kind='user'）与宿主自有注入不计。
   decision 原样透传（监听在宿主 waterfall 链上，零改写零抛错）。
3. **agent/request 链尾实发配置**：记录点在既有温度覆盖监听器内、`resolved`
   合成之后——记录与返回是同一形状（含覆盖值，「看到即实发」）；params 过
   `sanitizeParams`（密钥样键整对丢弃，与 ST 侧同款）。

合成时机在 agent/request：每 step 一次 LLM 请求 = 一条记录（与 ST 侧「一轮
生成一条」同粒度）。轮/步标记来自同 step 的 pre-step 捕获（agent/request
payload 类型只保证 agent.id）；合成先同步取捕获快照、再异步查绑定——读盘
期间会话推进不会造成错标。

## 纪律（与 A-6 同源）

- **纯观察**：捕获监听整体吞错、decision 原样透传；合成 fire-and-forget +
  整体吞错 + 宿主日志一行。任何一环炸不了请求路径。
- **绑定门控**：未绑定 / 非 agent-tavern / group 会话静默跳过——
  `tavern_deduce` 子代理（继承父 system 但自有 agent id 无绑定）、主 DSH
  助手、AgentNovel 会话天然不入记录面（Novel bundle 需要时同款接法另立
  决策）。
- **空文本段摘除**：装载中 / 无资产通道返回空串时不进 sections（宿主对空
  context 同款摘除语义），全部为空时 system 不带键。

## 边界（如实记录，面板 hint 同步标注）

- promptTokens 只覆盖预注入面（system + 注入消息），**不是完整请求体积**
  ——宿主历史 / 工具上下文不可见。
- loreTrace 恒 undefined：Agent 模式世界书走 `tavern_lore_search` 工具按需
  检索，没有 ST 式整轮激活轨迹。
- 同一 step 内若有绕过 pre-step 的宿主内部请求（审计只描述 preStep→step
  单循环，未观察到），轮/步标记沿用上次捕获——内容面（sections/params）
  不受影响，标记缺省时不误标（测试锁住）。
- 若未来有更外层的 agent/request 监听改写 config，记录点需随之外移（当前
  本插件是链上唯一监听）。

## 数据形状（增量）

```ts
PromptViewerRecord.agent?: {
  sessionId: string          // 宿主会话 id（= sessionBindings 绑定键）
  turn?: number              // 最近一次 pre-step 的轮标记
  step?: number
  sections: { name, order, text }[]   // 按 order 升序，空文本段已摘除
}
// mode = 'agent-tavern'；system = sections 文本 '\n\n' 拼接（供 token 估算
// 与旧渲染兜底）；messages = 本步插件注入消息（脱壳纯文本，通常 0-1 条）
```

面板：Agent 记录分面展示 sections（复用长文折叠组件，`名字 · order` 摘要行）、
消息面标「本步注入消息」、不渲染 loreTrace 区、summary 行带 `T{turn}/S{step}`。

## 测试

`packages/plugin/tests/agent-prompt-viewer.spec.ts`（11 项）：

- pre-step 捕获：只收 plugin source 消息 + 轮步标记（用户消息 / 外来插件注入
  排除）；非 enter 决策原样透传不碰捕获；同 agent 末次捕获覆盖 + 无 session id
  忽略；messages getter 抛错被吞、decision 不受影响。
- 合成（经真实 apply 的 agent/request 监听器驱动）：链尾最终 params（预设
  温度覆盖后值 + apiKeyEnv 净化）、四条通道装载后齐面（kernel/preset/facts；
  guides/script 无资产空摘除）、注入消息脱壳、agent 补充面逐字段、system =
  拼接、promptTokens > 0、零警告；未绑定（deduce 子代理同型）与 group 绑定
  零记录；无 pre-step 捕获时 turn/step 缺省不误标。
- 覆盖面锁：apply 注册的内置五段（名字/order/kind）与硬编码表严格相等 +
  读取面不产生注册面之外的段；mod 段进读取面（越界 order 钳 -50、`{{...}}`
  中性化、排序在核心段之后）。
- 客户端：两个新渲染键 zh/en 各一次 + 负样本。

回归：agent-tavern-preset.spec（agent/request 监听器直接调用范式）与
prompt-viewer.spec（ST 侧记录面）零改动通过。
