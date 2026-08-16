# DSH AgentLoop 原生能力审计

> 审计日期：2026-08-16。目标运行时：DSH `0.1.0-rc.6` 编译产物。
> 本记录用于决定 AgentTavern 是否需要 Fabric；它不是对 DSH 私有实现的长期兼容承诺。

## 结论

AgentTavern 的 MVP 不需要 Fabric。DSH 已经提供了足够的原生 seam：

- `dsh-agent-presets`：按 preset 挂载一组 agent-scoped 工具、prompt 和 projection 插件；
- `dsh-system-prompt`：每个 agent 的 `section`、`context`、`tools`、`variable`；
- `dsh-agent-loop`：原生 `AgentLoop`、工具调度、`agent/pre-step`、`agent/session-start` 和 `agent.inject()`；
- `dsh-compaction` / `dsh-compaction-basic`：可替换的 compaction service、surface range replacement 和 pressure/overflow recovery；
- `dsh-session`：append-only event log 与 model-visible surface。

因此角色身份、kernel、工具、变量、记忆读写和 DSH 自己的 pressure/overflow recovery 都可以复用。`dsh-native` 模式现在即可实现：AgentTavern 不安装历史 projection，当前容量直接由实际 provider/model route 的 `contextWindow` 和 DSH 策略决定。真正未公开的能力只有：在不改变 durable surface 的情况下，对每个请求临时选择任意历史节点。这个能力应由 DSH 增加一个小型的 `agent/context`（或 `agent/message-projection`）seam；在该 seam 出现前，用 `agent/pre-step` 适配器承载固定注入和工具注册，并明确关闭 `agent-managed`，不能把 compaction 误称为可逆的主动遗忘。

## 核对的原生路径

### 1. AgentLoop 请求边界

`@deepseek-ai/dsh-agent-loop/lib/index.js` 的顺序是：

```text
preStep()
  claim inbox
  systemPrompt.assemble(assembleContextFor(agent, signal))
  waterfall("agent/pre-step", ...)
  append returned user messages to session

step()
  session.deriveMessages()
  buildRequest(..., boundaryMessages)
  llm.stream(request)
```

`agent/pre-step` 的 payload 包含真实 `agent`、被领取的 `messages`、`turn`、`step` 和 `signal`。listener 可以返回 `reject`，也可以替换进入当前 step 的完整 user-message batch。`agent/session-start` 可以通过 `agent.inject()` 写入持久、模型可见的初始化消息。

`agent/request` 只允许替换 provider/model/reasoning/maxTokens 等调用配置。类型注释明确规定 model-visible content 必须走 logged channels，不能在该 waterfall 中改 messages。

### 2. Agent-scoped profile 与 prompt

`@deepseek-ai/dsh-agent-presets` 的 `mount(agentCtx, id)` 在 agent 尚未发布时挂载 standing composition，并把 agent 的 scope 接到 preset scope。preset 贡献的工具、prompt section、dynamic context 和 projection unit 只对加入该 preset 的 agent 生效；session header 与 `agent-preset/selected` 事件记录可重建的 preset 身份。

`@deepseek-ai/dsh-system-prompt` 已提供：

```ts
agentCtx.systemPrompt.section(...)
agentCtx.systemPrompt.context(...)
agentCtx.systemPrompt.tools(...)
agentCtx.systemPrompt.variable(...)
```

`context()` 每次 assembly 求值，并由 shipped loop 物化为带 source 的 user-role runtime snapshot。它适合 kernel 的动态事实和当前状态，但不是任意历史消息的临时过滤器；旧 snapshot 仍在 surface 上，直到 compaction shadow 它。

### 3. 原生工具与结果回流

AgentLoop 在一个 step 中记录 `tool/call`、执行原生工具、记录 `tool/result`，并将 `additionalContexts` 放入 next-step inbox。下一步会重新 assembly 和 derive history。因此 `memory_search`、`memory_write`、`variable_get/set`、`tavern_lore_search` 等工具不需要插件自建生成循环。

### 4. Session surface 与 compaction

`@deepseek-ai/dsh-session` 的 `Session.deriveMessages()` 是从 surface nodes 的唯一 canonical projection。`surfaceOp: { op: 'replace', start, end }` 可以用一个新 surface message shadow 一段旧节点，原始 append-origin 事件仍留在 durable log 中。

`@deepseek-ai/dsh-compaction` 已是正式 Service Definition，`CompactionEngine` 暴露 `compactIfNeeded`、`compactNow` 和 `compactRegion`。`dsh-compaction-basic` 在 `agent/pre-step` 做 pressure compaction，在 `agent/request-error` 做 context-overflow recovery；它允许替换 summarizer，也允许扩展 retention policy。该能力适合宿主安全压缩和 overflow recovery，但 surface replacement 会改变后续请求看到的 surface，不能满足两个 context mode 间的可逆切换，因此不应作为 AgentTavern 的默认主动遗忘实现。

如果“非 kernel 内容只能由工具取回”被解释为禁止隐藏的辅助 LLM 调用，AgentTavern 不应直接启用 basic compaction 的默认 summarizer；应把摘要放进显式的 curator profile。compaction seam 本身仍可作为 DSH 宿主安全机制复用。

### 两种 context mode

| 模式 | 当前 DSH 能力 | AgentTavern 行为 | Fabric/宿主要求 |
|---|---|---|---|
| `dsh-native` | 已满足 | 不筛选历史、不主动调用 compaction；服从实际 route 的 `contextWindow`、pressure policy 和 overflow recovery | 无 `agent/context` 要求；无需 Fabric |
| `agent-managed` | 缺少非破坏性历史投影 | 通过 `agent/context` 临时选择 durable surface，依靠 memory/history 工具取回被排除内容 | 需要正式 `agent/context`，并要求 compaction 测量 effective projection 或提供 scoped suppression；缺失则拒绝启用 |

两种模式共用 AgentLoop、preset、工具、memory/variable store 和 session log。`contextMode` 不是 memory tools 开关；它只决定 AgentTavern 是否主动投影旧历史。

## 真正缺口

当前公开接口没有让插件替换以下表达式的入口：

```js
session.deriveMessages()
```

现有 `agent/pre-step` 只能改变当前 step 新进入的 user messages；`system-prompt.context` 是持久 snapshot；`agent/request` 不能改 messages；`session-projection` 只服务 UI/API 的 read projection，不参与模型请求。

这意味着“按相关度把旧消息暂时排除，但下一次仍可从 durable history 检索”不能只靠现有公开接口完成。不能把 `agent/pre-step` 适配器描述成完整的 per-request forgetting seam。

## 建议的正式宿主 seam

不要再为 DSH 增加一个与 `dsh-agent-presets` 重叠的 profile registry。建议保留现有 profile 组合，只增加请求历史投影 seam：

```ts
interface AgentContextNode {
  seq: number
  message: Message
}

interface AgentContextProjection {
  /** 按当前 surface 顺序保留的节点；宿主会强制合并 requiredSeqs。 */
  include: readonly number[]
  /** profile/策略版本，用于诊断和 request reconstruction。 */
  revision?: string
}

interface AgentContextPayload {
  agent: Agent
  turn: number
  step: number
  nodes: readonly AgentContextNode[]
  /** 当前 step 的 user messages 与正在继续的 assistant/tool 单元，不能被投影丢弃。 */
  requiredSeqs: readonly number[]
  system: string
  tools: readonly ToolSchema[]
  signal: AbortSignal
}

// scope-filtered waterfall; default returns all current surface nodes
'agent/context'(
  payload: AgentContextPayload,
  next: () => Promise<AgentContextProjection>,
): Promise<AgentContextProjection>
```

宿主必须负责以下不变量：

1. waterfall 位于当前 step 的 user messages 已 append 之后、`buildRequest()` 之前；
2. `include` 只能引用当前 surface nodes，去重并保持 surface 顺序；宿主必须合并 `requiredSeqs`，且不能拆开 assistant tool-call 与对应 tool-result；
3. 新的 model-visible 内容仍必须通过 `agent.inject()`、`systemPrompt.context()` 或工具结果进入 logged channels，projection 不能凭空制造 Message；
4. 非默认投影要写入一个 request-scoped projection event（例如 `request/projection`），记录 `turn`、`step`、surface generation 和 `include`，使 request invariant 可以从 session log 重建准确的 message boundary；
5. surface 在投影等待期间发生 replacement 时必须重新计算或拒绝本 step，不能把旧 seq 静默送给模型；
6. 无 listener 时保持 `session.deriveMessages()` 的现有行为，旧 session log 仍可按默认规则恢复。

该接口比允许插件替换整个 LLM request 更窄：它只负责选择 durable surface，工具授权、系统 prompt、请求配置、取消、重试和事件仍归 AgentLoop 所有。

需要特别修正 compaction 的排序假设：当前 basic compaction 在 `agent/pre-step` 可能基于完整 surface 提前触发，随后才有机会运行 `agent/context`。宿主若要支持 managed，必须让 pressure 测量使用 effective projection 并在 replacement 后重新投影，或者向 profile/session 暴露 suppression/policy，使 managed 只由实际 request overflow 触发宿主 recovery；否则只能开放 `dsh-native`。

## Fabric fallback 判定

Fabric 仅在以下条件同时满足时启用：

- DSH 宿主暂时没有上述 `agent/context` seam；
- AgentTavern 必须在当前版本实现非破坏性的 per-request history projection；
- 运行环境是已安装 Fabric loader hook 的 DSH source checkout，而不是未接入 host patch 的普通 npm CLI。

临时 patch 的优先目标是 `ReactLoopAgent.buildRequest` 或 `step`，只对 AgentTavern session（通过 session id/WeakSet 识别）替换 boundary messages。不要全局 patch `Session.deriveMessages()`，否则会污染所有 agent、破坏 DSH request invariant，并且无法表达 profile 作用域。

Fabric patch 必须声明 DSH 版本、`lib/index.js`/source launch form、目标函数和 `required: true`；目标未绑定时应拒绝 `agent-managed` 并保留 `dsh-native`/ST，而不是静默宣称已启用遗忘。该 patch 是验证宿主 seam 的过渡方案，不应成为默认生产依赖。

## 结论矩阵

| 能力 | 现有 DSH | AgentTavern 方案 |
|---|---|---|
| Profile 选择 | `dsh-agent-presets` | 原生 preset `agent-tavern` |
| Kernel/身份 | `systemPrompt.section/context` | preset-scoped 固定内容 |
| 工具与变量 | `tools`、工具 pipeline | 原生 memory/variable/Tavern tools |
| 工具结果下一步回流 | AgentLoop inbox | 原生 AgentLoop |
| DSH 压力/溢出保护 | `CompactionEngine` | 两种模式都可由宿主执行；不等于 AgentTavern 主动遗忘 |
| 每请求任意历史投影 | 缺少公开 seam | `dsh-native` 不需要；`agent-managed` 需要 DSH `agent/context`，短期 Fabric 仅用于 source checkout 验证 |
| 实际上下文容量 | provider/model route 的 `contextWindow` | `dsh-native` 直接服从；`agent-managed` 以它为硬上限 |
| ST 兼容生成 | 不相关 | 保留当前 ST profile |
