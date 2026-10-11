# 试写预览：生成不入楼（D-4）

> 日期：2026-10-11。来源：[JSR/LWB 竞品参考](../docs/exploration/2026-10-11-jsr-lwb-reference.md)
> §3.5/§4 的 D-4 建议（LWB message-preview 用 fetch 包装实现「生成不入楼」；
> LWB 为 Apache-2.0——只复刻可观察语义，重新实现，零代码拷贝）。dsh 的对应物
> 是卡片工作台的排错/试写入口：跑一遍真实装配 + 生成，但不落任何楼、不触发任何
> 副作用。落点：`packages/plugin/src/index.ts`（装配共享助手提取 + preview 路由）、
> `packages/plugin/client/main.js`（工作台「试写」分区）、
> `packages/plugin/tests/preview-generation.spec.ts`（新）。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/src/index.ts` 的 `previewGeneration`（HTTP + 编排）；装配归共享助手 `buildGenerationLlmRequest` / `resolveGenerationSpeaker`（runGeneration 与 preview 共用，行为单一事实来源） |
| 唯一事实来源 | 聊天文件（`<tavern>/chats/…`，只读快照）+ 激活资产（preset/persona/世界书，只读）；preview 自身零持久态 |
| 持久态 | **无**。preview 不落任何盘——这是本决策的核心承诺，测试逐字节锁死 |
| 临时态 | `structuredClone` 的聊天工作副本（装配期 timedWorldInfo / scriptProgress / 模板变量写全落其上，请求结束即弃）+ 进程内请求作用域 |
| 外部依赖 | 无新依赖。复用 ctx.llm.stream（宿主 LLM 路由）与既有装配链（tavern-pipeline / tavern-lore / tavern-macros / template.ts） |
| 注册入口 | HTTP `POST /api/dsh-tavern/preview`（handleApi，candidates 路由之后）；面板工作台分区 `WorkbenchPreviewBand`（client/main.js，方案列表之下） |
| 删除路径 | 删 index.ts 的 preview 路由分支 + `previewGeneration` + main.js 的 `WorkbenchPreviewBand` 与 locale 键 + 本决策文档 + spec。**共享装配助手不随删**——它们是 runGeneration 的既有逻辑提取，preview 只是第二个消费者 |
| 兼容对象 | runGeneration 行为零改动（16 项 hook 接线 + rewrite/group-nudge/mvu/prompt-viewer 回归全绿）；README 测试基线数字不动；mod-api.md 不动（不是 Mod 面） |

## 方案

### HTTP

`POST /api/dsh-tavern/preview {character, chatId, userText, group?}` → 同步收集
返回 `{ok, text, provider, model, usage?, finish?}`（收集出口对齐 mods/host.ts
`api.llm.request` 的 `{text, reasoning, usage, finish}` 形状；reasoning v1 不带，
provider/model 是附加信息位——工作台排错需要知道「这次是谁生成的」）。

- 聊天不存在 404；`userText` 空串/缺 `chatId` 400；无 revision 参数（只读，无 CAS）。
- **中止**：`req 'aborted'` / `res 'close'` → AbortController → 透传 `signal` 给
  `ctx.llm.stream`（与 generate 同款接线）。
- **流式**：v1 同步收集（单次 LLM 调用 30-60s 量级；客户端 fetch 不设短超时）。

### 装配复用（不复制粘贴）

runGeneration 中段提取为两个共享助手，preview 与真实生成走同一份代码：

1. `resolveGenerationSpeaker`（index.ts）：群聊发言者/nudge/回合视图解析（原
   runGeneration 首段）。纯读取。
2. `buildGenerationLlmRequest`（index.ts）：preset/persona/世界书激活/模板/宏/
   persona 位置/示例块/@Depth 注入/群聊 nudge/`assemblePrompt`/模型选择推导
   （`explicit ?? saved ?? fallback`，与 candidates.ts 同语义）/剧本块/system 段
   （含 guides 与重写意见块）→ 进 `llm.stream` 的最终请求。
   pre-assemble / pre-llm 两相位经 seam 参数（`onDraft` / `onLlmRequest`）由调用方
   注入：runGeneration 传 `generationHooks.dispatch`，preview 不传（= 恒等跳过）。
   副作用边界：只写传入的 chat 工作副本与 tpl 内部状态。

preview 编排：读快照 → structuredClone → 共享助手解析发言者 → USER_INPUT regex
（装配的一部分，确定性本地变换）后临时 push 用户楼层 → 共享助手装配 → llm.stream
同步收集。模型取**绑定该聊天的 ST 会话**（`sessionBindings` 命中 character+chatId
且 `architecture === 'st'`，多会话取首个有选择的）的会话级选择，未命中回落部署
默认——与 composer 未选模型时同款。

### 零副作用清单（决策承诺 + 测试逐项锁死）

| # | 项 | 机制 | 测试 |
|---|---|---|---|
| 1 | 不落楼 | 全程无 saveChat；装配写全落 structuredClone 副本 | DSH_HOME 全树 sha256 逐字节比对 + revision/楼层逐项相等 |
| 2 | 无 MVU 结算/回执 | 不调 snapshotChatVariables/applyMvuSettlementGuard/recordMvuTurnReceipt | 全树比对（回执落在聊天文件内） |
| 3 | 无 swipe/楼层变化 | 不 push 助手楼层 | messages 数组逐项相等 |
| 4 | 无 chat-saved/stream-delta/assets-saved 事件 | 不调 emitChatSaved/emitStreamDelta/beginStreamEpoch | modEvents 挂监听断言零发射 |
| 5 | 五相位 hook 全不跑 | 不注入 seam；user-input/post-output/post-save 在 runGeneration 体内不经过 | 五相位挂探针断言零调用 |
| 6 | 无 DSH session 镜像 | 不传 hostAgent、不 beginTavernSessionTurn | （无会话对象可写，代码路径不经过） |
| 7 | prompt-viewer 零记录 | 不调 recordPromptView（只记真实生成的实发请求，preview 会污染调试面） | listPromptViews 断言空 |

### 与真实生成的行为差（诚实边界）

- **五相位 hook 不跑**：带 hook 的 Mod 在 preview 里看不到这次生成（mod 副作用
  不可控，v1 如实跳过）。排错时若怀疑 hook 改写 prompt，用提示词查看器看真实
  请求，preview 只回答「装配基线长什么样」。
- **USER_INPUT regex 照跑**（确定性本地变换，属装配），但 user-input hook 不跑。
- 模型输出不经过 post-output regex / 模板输出渲染——preview 返回模型原文。
- 剧本对齐推进判定照跑但只写工作副本（真实生成会推进 scriptProgress 落盘）。

### 并发语义

- preview 是只读快照，**与同一聊天的真实生成可并存**（真实生成的 saveChat 有
  revision CAS，preview 不写不冲突；preview 读到的是请求时刻快照）。
- preview 自身**不限并发**（v1）：两次并发 preview 各自克隆、互不影响；代价是
  并发 preview 各自打一次 LLM 请求，由调用方（工作台 UI 生成中禁用按钮）自律。
  若要服务端限流属 v2。

## 否决项（v2 候选）

- **SSE 流式下行**：工作台排错场景需要的是完整结果 + usage，不是打字机；同步
  收集让客户端逻辑最小（AbortController 取消即可）。真实生成的 SSE 已有。
- **聊天分区入口**：v1 工作台专用（排错场景聚合在工作台）；用户日常试写用既有
  带意见重写 / swipe，语义不同（那两个是「重掷已有回复」，preview 是「还没发生
  的下一楼」）。
- **reasoning 透传**：排错时正文 + usage 足够定位；reasoning 体积大，进面板收益低。
- **服务端并发限制/排队**：v1 不做，见并发语义节。

## 与规格的偏差

- 响应多带 `provider` / `model` 两键（规格 `{ok, text, usage?, finish?}`）：
  附加信息位，收集形状不变；工作台 usage 行需要它。
- 客户端 marker 测试随 spec 附带（对齐 prompt-viewer.spec.ts 的 house style），
  规格未明确要求。

## 测试

`packages/plugin/tests/preview-generation.spec.ts`（5 项）：

- 装配正确性 + 收集出口：preset main / persona / 世界书激活内容进 llm 请求、
  userText 末位、{{char}} 展开且无残留、text/usage/finish 透传、默认模型回落；
- 零副作用矩阵（上表 1-5、7，全树 sha256 最强断言）；
- 模型选择：ST 会话选择优先 / agent-tavern 绑定不参与 / 无选择回落默认；
- 400（空 userText、缺 chatId）/ 404（聊天不存在），且不触发 llm 请求；
- abort：signal 透传给 llm.stream、以错误面浮出、聊天零变化；
- 客户端接线与 zh/en 文案 marker。

回归：`tavern-generation-hooks.spec.ts`（16，五相位接线不受提取影响）、
`tavern-rewrite.spec.ts`（9）、`prompt-viewer.spec.ts`（13）、`tavern-group-nudge.spec.ts`
（2）、`tavern-mvu.spec.ts`（25）全绿。
