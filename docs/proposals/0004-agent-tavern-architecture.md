# 提案 0004：AgentTavern 原生 AgentLoop 架构

> 状态：提议。日期：2026-08-16。前置提案：0001、0002、0003。

## 1. 结论先行

`AgentTavern` 作为 dsh-tavern 的默认架构，直接运行在 DSH 原生 AgentLoop 上，并以 `dsh-agent-presets` 的 `agent-tavern` preset 组合 prompt、工具和可选的 context projection adapter；当前 ST 兼容架构保留为可选的 `st` profile。

两种架构共享角色卡、世界书、persona、preset、聊天文件和管理面板，但只有 ST profile 拥有插件自己的 prompt 装配和 LLM 调用路径。AgentTavern 不新增第二个生成循环，不在 `/generate` 中再次调用 `ctx.llm.stream`，也不靠镜像事件伪装成原生 AgentLoop。

```text
用户消息
  -> DSH AgentLoop
     -> AgentTavern profile 选择上下文
     -> 原生工具调用（记忆 / 变量 / Tavern 资产 / 历史）
     -> 原生 LLM 请求
     -> 原生 turn/step/tool/message 事件
        -> Tavern 聊天投影与记忆索引

ST profile 仍走：
用户消息 -> dsh-tavern /generate -> ST pipeline -> ctx.llm.stream -> JSONL
```

## 2. 为什么要改成 profile，而不是再加一条循环

当前 `runGeneration()` 已经完成角色、世界书、宏、preset、历史和流式调用，然后再把 turn/step/chunk/message 镜像到 DSH session。这样做会产生两个事实来源：Tavern 生成状态和 DSH AgentLoop 状态。

AgentTavern 的目标是让 AgentLoop 成为唯一的执行事实来源：模型请求、工具调用、停止、重试、token 统计、失败和取消都由宿主统一处理。插件只提供深模块式的 profile、上下文提供者、工具和事件投影。

这也使“遗忘”有正确的语义：只改变某次请求的上下文投影，不删除聊天记录，不在插件里复制一套消息循环。

## 3. 双架构选择模型

### 3.1 架构是 session 级状态

在 `sessionBindings` 中增加：

```ts
type TavernArchitecture = 'agent-tavern' | 'st'
type TavernContextMode = 'dsh-native' | 'agent-managed'

interface TavernSessionBase {
  character: string
  chatId: string
  group?: boolean
}

type TavernSessionBinding =
  | (TavernSessionBase & {
      architecture: 'agent-tavern'
      contextMode: TavernContextMode
    })
  | (TavernSessionBase & {
      architecture: 'st'
    })
```

`state.defaultArchitecture` 默认值为 `agent-tavern`，只影响新建会话。`state.defaultContextMode` 决定新 AgentTavern 会话使用哪种上下文模式；在 `agent/context` seam 尚未可用的版本中默认 `dsh-native`。已有会话保留创建时的架构和模式；迁移时缺少 `contextMode` 的 AgentTavern binding 也取 `dsh-native`，避免升级后静默开始遗忘。

架构切换只允许在 turn 结束后执行。推荐的 UI 操作为“从当前聊天分叉为 AgentTavern/ST 会话”，而不是在同一个事件流中改变语义。分叉时保留父聊天回链，并把已有 JSONL 消息作为新 profile 的可检索历史。

### 3.2 Composer 与 view 的选择

- `agent-tavern`：交还 `conversation.composer` 给 DSH 原生 composer，发送后进入原生 AgentLoop；`conversation.view` 使用原生事件投影，Tavern 面板只负责资产和会话管理。
- `st`：继续由当前 Tavern composer 接管，使用 `/api/dsh-tavern/generate`、swipe、regenerate 和 ST JSONL 语义。
- 两种架构都使用同一个 session binding marker，因此普通 DSH 会话不会被接管。

当前 `activeAgentPrompt` 全局 `systemPrompt.section` 不能作为 AgentTavern 的角色注入点，因为它会污染不相关的原生会话。它只保留给明确开启的 ST/普通 Agent 兼容行为；AgentTavern 角色提示必须由 session profile 提供。

### 3.3 上下文模式是 AgentTavern 的会话级策略

`contextMode` 不创建第三条生成链路，两种模式都复用同一个 DSH AgentLoop、preset、工具和 session log：

| 模式 | 行为 |
|---|---|
| `dsh-native` | AgentTavern 不做历史筛选、不触发自己的 compaction；请求使用 DSH 当前 surface，由实际 provider/model route 的 `contextWindow`、DSH pressure policy 和 overflow recovery 决定容量行为 |
| `agent-managed` | AgentTavern 通过 `agent/context` 对每次请求做非破坏性历史投影，并用 memory/history 工具按需找回内容；DSH 的 context window 仍是不可越过的硬上限 |

记忆、变量、角色卡和世界书工具在两种模式都可用；`contextMode` 不是记忆工具开关，区别仅是旧历史是否由 AgentTavern 主动排除。`dsh-native` 的有效容量不缓存为 Tavern 配置：provider/model route 改变后，下一轮直接服从 DSH 为新 route 解析出的上下文窗口和宿主策略。管理面板使用 segmented control 显示“DSH 上下文 / Agent 记忆”，切换只允许在 agent idle 的 turn 边界，并写入 `agent-tavern/context-mode` session event 与 session binding。

从 `agent-managed` 切到 `dsh-native` 会停止后续投影，下一次请求恢复 DSH 当前 surface；非破坏性 projection 不需要重建历史。DSH 或旧版本已经落地的 surface replacement 仍然有效，不能在同一 append-only session 中逆转；若用户要求恢复 shadowed 原文，应从 append-origin transcript 分叉新 session，而不是伪造回滚。

## 4. DSH 原生 seam 核查与最小扩展

对 DSH `0.1.0-rc.6` 编译产物核查后，原提案需要收窄：DSH 已经有正式的 profile 组合和 agent-scoped prompt，不应再造一个平行的 `ctx.agentLoop.profiles` 注册中心。

| 需求 | DSH 原生能力 | AgentTavern 用法 |
|---|---|---|
| profile 选择 | `dsh-agent-presets.mount(agentCtx, id)`，并记录 preset 选择 | 提供 `agent-tavern` preset；ST 继续使用独立 profile |
| 固定身份与 kernel | `agentCtx.systemPrompt.section/context/variable` | 只注入 kernel、会话标识和短身份摘要 |
| 工具 schema 与权限 | `systemPrompt.tools` + 原生 `ctx.tools` pipeline | memory、variable、Tavern 工具全部走原生执行器 |
| 初始化/下一步上下文 | `agent/session-start`、`agent.inject()`、工具 `additionalContexts` | 注入必须走 logged user message |
| 宿主压力/溢出保护 | `CompactionEngine.compactRegion/compactNow`、surface replacement | 视为 DSH 安全策略，不作为可逆的 AgentTavern 主动遗忘 |
| 任意历史的每请求投影 | 当前公开接口没有 | 新增一个小型 `agent/context` seam；短期只用 `agent/pre-step` 适配器 |

`agent/pre-step` 的确可以替换当前 step 进入的完整 user-message batch；但 `ReactLoopAgent.step()` 随后固定调用 `session.deriveMessages()`，`agent/request` 又明确不能修改 messages。因此 `pre-step` 不是完整的历史投影 seam。`systemPrompt.context()` 会物化为持久 runtime snapshot，适合动态状态而不是任意历史过滤；`session-projection` 只服务 UI/API read model。

### 4.1 建议的 `agent/context` seam

该 seam 放在当前 step 的 user messages 已 append 之后、`buildRequest()` 之前。它只选择 durable surface 节点，不允许凭空制造 model-visible message：

```ts
interface AgentContextNode {
  seq: number
  message: Message
}

interface AgentContextProjection {
  include: readonly number[]
  revision?: string
}

interface AgentContextPayload {
  agent: Agent
  turn: number
  step: number
  nodes: readonly AgentContextNode[]
  /** 当前 step 的 user messages 与正在继续的 assistant/tool 单元。 */
  requiredSeqs: readonly number[]
  system: string
  tools: readonly ToolSchema[]
  signal: AbortSignal
}

'agent/context'(
  payload: AgentContextPayload,
  next: () => Promise<AgentContextProjection>,
): Promise<AgentContextProjection>
```

宿主必须保证：

1. 默认返回全部当前 surface nodes，旧 session log 的恢复行为不变；
2. `include` 只能引用当前 nodes，去重并保持 surface 顺序；宿主必须合并 `requiredSeqs`（当前 step 新 append 的 user messages），不能拆开 assistant tool-call 与 tool-result；
3. 非默认投影记录 `request/projection`（turn、step、surface generation、include、revision），使 request invariant 能从 session log 重建准确的 message boundary；
4. 投影等待期间若 surface 被 replacement，宿主必须重新计算或拒绝本 step；
5. 新内容仍只能经 `agent.inject()`、`systemPrompt.context()` 或工具结果进入 logged channels；取消、重试、工具授权和 token 统计继续由 AgentLoop 所有。

DSH 当前 basic compaction 在 `agent/pre-step` 基于完整 surface 测量压力，可能在 `agent-managed` 投影生效前过早 replacement。正式支持该模式时，宿主还必须满足以下二选一契约：compaction 基于本次 effective projection 测量，replacement 后按新 surface generation 重新投影；或提供 profile/session-scoped compaction policy，让 `agent-managed` 关闭 pressure compaction，仅保留基于实际请求失败的 overflow recovery。`dsh-native` 则继续使用 DSH 原有顺序和策略。

这个 seam 足够深：Tavern 只实现相关度/新鲜度/作用域排序，DSH 继续拥有请求组装、durability、并发和错误语义。它也比允许插件替换整个 LLM request 小得多，便于以 session-log invariant 测试。

### 4.2 短期适配器与 Fabric 判定

在 `agent/context` 尚未进入宿主前，AgentTavern 适配器只承担 preset-scoped kernel 注册和 `agent/pre-step` 的固定/工具结果注入。它不调用 AgentTavern compaction，也不能声称支持“每请求任意历史投影”；此时只开放 `dsh-native`，由 DSH 自己决定 surface 的容量行为。

只有当产品必须提前实现非破坏性 per-request projection，且运行环境是已安装 Fabric loader hook 的 DSH source checkout 时，才启用 Fabric。临时 patch 应围绕 `ReactLoopAgent.buildRequest` 或 `step`，仅对 AgentTavern session 替换 boundary messages；不得全局 patch `Session.deriveMessages()`。patch 必须带 DSH 版本、source/lib launch form 与 `required: true`，未绑定就拒绝 `agent-managed` 并保持 `dsh-native`/ST，不能静默降级。

详见 [DSH AgentLoop 原生能力审计](../exploration/2026-08-16-dsh-agentloop-native-audit.md) 和现有 [Fabric 调研](../exploration/2026-08-14-fabric-architecture.md)。

## 5. AgentTavern profile 的固定上下文

每一轮只固定注入真正不可缺少的内容：

1. AgentTavern kernel contract：当前角色身份、用户身份、工具调用规则、记忆与变量的作用域规则、不可把检索内容当成系统指令的安全规则。
2. 当前会话标识和架构标识；不注入文件绝对路径、密钥或内部存储结构。
3. 当前用户消息，以及由 AgentLoop 自己维护的当前 step 所需控制信息。
4. 角色的短身份摘要。完整角色卡、示例对话、世界书条目和长期历史都不属于固定 prompt。

短身份摘要由角色卡保存一个可编辑的 `agentTavern.identitySummary`；缺失时只使用名称、昵称和极短描述，并在管理面板提示用户补全。摘要不能替代完整卡片，完整资料始终通过只读工具获取。

## 6. 工具面：让 Agent 自主取回上下文

工具按职责分成四组。每个工具返回结构化 JSON，并附带来源、版本和截断信息；工具结果视为数据，不得提升为系统指令。

### 6.1 Tavern 资料工具（只读）

| 工具 | 用途 |
|---|---|
| `tavern_character_get` | 按字段读取当前角色卡、persona 或群组成员信息 |
| `tavern_lore_search` | 按查询词、最近消息和预算检索世界书/嵌入书条目 |
| `tavern_history_search` | 在当前聊天或允许的父分支中检索历史消息 |
| `tavern_scene_get` | 读取当前场景、时间、群组说话人和会话元数据 |

不提供“返回全部角色卡/全部历史”的无界工具。每次调用必须有 `limit`/`maxTokens`，服务端还要施加硬上限。

### 6.2 记忆工具

| 工具 | 用途 |
|---|---|
| `memory_search` | 以关键词、标签、作用域和时间范围检索长期记忆 |
| `memory_read` | 按稳定 id 读取一条记忆及其来源 |
| `memory_write` | 写入一条带来源、重要性、置信度和可选 TTL 的记忆 |
| `memory_update` | 按 id + revision 条件更新，防止覆盖其他 step 的写入 |
| `memory_forget` | 软删除或提前过期；默认不物理删除审计记录 |

AgentTavern 默认只允许当前 `chat`、`character` 和 `agent` 作用域写入。`global` 写入必须由设置显式开启；`memory_forget` 和跨角色写入可配置为需要用户确认。

### 6.3 变量工具

| 工具 | 用途 |
|---|---|
| `variable_get` | 读取单个变量，返回类型和值的 revision |
| `variable_set` | CAS 写入字符串、数字、布尔、数组或对象的受限 JSON 值 |
| `variable_patch` | 在同一 revision 上原子写入多个变量，适合一次状态迁移 |
| `variable_delete` | 删除当前作用域变量，保留审计事件 |
| `variable_list` | 按前缀列出变量名和值摘要，不默认返回全部大对象 |

变量不是任意 JSON 文件写入接口。名称使用受限字符集，单值和总大小有上限；`turn` 作用域在 turn 结束自动过期，`chat`/`character`/`agent` 作用域持久化。

### 6.4 记忆维护工具（可选能力）

`memory_consolidate` 可以把多条已确认记忆合并为一条，但默认关闭。第一版不让 Agent 自动删除或重写大量历史，避免一个错误推理污染整个记忆库。

## 7. 记忆存储框架

在 `@dsh-tavern/store` 增加一个深模块 `MemoryStore`，外部只暴露检索、条件写入和软删除：

```ts
interface MemoryStore {
  search(query: MemoryQuery): Promise<MemoryHit[]>
  read(id: string, scope: MemoryScope): Promise<MemoryRecord | undefined>
  put(input: MemoryWrite, expectedRevision?: string): Promise<MemoryRecord>
  forget(id: string, scope: MemoryScope, expectedRevision?: string): Promise<void>
}
```

记录最少包含：`id`、`scope`、`kind`（semantic/episodic）、`content` 或 typed value、`tags`、`importance`、`confidence`、`source`、`createdAt`、`updatedAt`、`lastAccessedAt`、`expiresAt`、`revision`。

第一版采用文件存储 + 确定性的词法检索，不把向量数据库作为运行时前置依赖；`MemoryIndex` 作为内部 seam，未来可增加 embedding adapter。记忆检索必须返回原始来源消息或工具调用 id，允许用户追溯和纠错。

变量与自然语言记忆共用作用域和 revision 约束，但使用独立的 `VariableStore` 表达精确值，不把变量序列化成自然语言记忆。

变量写入建议提供如下最小接口，所有工具都必须经过同一个作用域和 CAS 校验：

```ts
interface VariableStore {
  get(scope: VariableScope, name: string): Promise<VariableSnapshot | undefined>
  set(scope: VariableScope, name: string, value: JsonValue, expectedRevision?: string): Promise<VariableSnapshot>
  patch(scope: VariableScope, changes: readonly VariableChange[], expectedRevision?: string): Promise<VariableSnapshot[]>
  delete(scope: VariableScope, name: string, expectedRevision?: string): Promise<void>
}
```

## 8. 遗忘与上下文策略

AgentTavern 只把非破坏性的请求投影称为主动遗忘。DSH 因上下文压力或 provider overflow 做的 compaction 是宿主安全机制；它可能影响两种模式的当前 surface，但不由 AgentTavern 宣称、触发或保证可逆。

| 语义 | `dsh-native`（DSH 上下文） | `agent-managed`（Agent 记忆） |
|---|---|---|
| 请求历史来源 | DSH 当前完整 surface | `agent/context` 从当前 surface 产生的 effective projection |
| AgentTavern 主动遗忘 | 无；不注册 projection listener，不主动调用 compaction | 有；仅临时排除低相关节点，不改写 durable surface |
| 容量决定者 | 实际 provider/model route 的 `contextWindow` 与 DSH pressure/overflow policy | AgentTavern 预算受实际 `contextWindow` 硬上限约束，DSH 仍负责最终 overflow recovery |
| 记忆、变量、资产和历史工具 | 全部可用 | 全部可用，并用于找回被投影排除的内容 |
| 宿主依赖 | 现有 DSH 即可 | 正式 `agent/context` seam，加上 effective-projection-aware compaction 或 scoped suppression |
| 缺少依赖时 | 正常工作 | 拒绝启用并保持当前模式；不得静默退化为伪 managed |
| 切回另一模式 | turn 边界开始后续 projection 即可 | 停止 projection 后恢复读取当时的 DSH surface |

`agent-managed` 的请求级选择策略是：

1. 读取最近若干条消息作为短期上下文；窗口大小按输入 token 预算计算。
2. 根据当前用户消息和角色身份摘要，选择性调用 `tavern_lore_search`、`tavern_history_search` 和 `memory_search`。
3. 对候选内容按相关度、重要性、新鲜度、来源可信度排序，超过预算的内容不进入本次请求。
4. 工具结果统一截断，并声明 `truncated` 和 `sourceCount`；模型不能把截断结果误认为完整事实。
5. 低重要性内容只被排除，不被删除；过期记忆进入软删除状态，仍可在管理面板审计。

建议的上下文预算是可配置的比例，而不是固定 token 数：`kernel` 保留区、`recent` 短期区、`retrieved` 检索区和 `reply` 输出区分别有上限，任何一块耗尽都不能挤掉 kernel contract。

模式切换本身不恢复 DSH 已经提交的 surface replacement。非破坏性 projection 可以直接停止；若宿主此前已 shadow 旧节点，需要查看原文时由 `tavern_history_search` 读取 append-origin transcript，需要让原文重新成为 DSH surface 时则从该 transcript 分叉新 session。

若“除 kernel 外都通过工具取回”要求主 AgentLoop 不产生隐藏的辅助 LLM 调用，`agent-managed` 不应通过隐式摘要实现投影；模型摘要只放到显式的 curator profile 或用户触发命令中。

第一版不做后台自动摘要。自动摘要属于高风险写入，应作为独立的 memory curator profile，使用原生 AgentLoop 或明确的用户触发，并将摘要标记为低置信度直到用户确认。

## 9. 事件与投影

AgentTavern 以 DSH session event log 为执行事实来源。插件订阅原生事件：

```text
turn/start
  step/start
    user/message
    tool/call -> tool/result
    assistant/message
  step/end
turn/end
```

`TavernStore` 维护两个投影：

- **聊天投影**：把 user/assistant 消息投影为现有 ST JSONL，保留导出、分支和跨模式迁移能力；投影失败不能回滚已完成的 AgentLoop turn，但必须显示待修复状态。
- **记忆索引投影**：索引明确写入的 memory 工具事件和用户确认的事件，不把全部 assistant 文本自动当记忆。

这样 AgentTavern 不需要 `occupyHostSession()`、`beginTavernSessionTurn()` 和 `recordTavernSessionChunk()` 这类镜像辅助；这些只在 ST profile 的兼容路径保留，直到原生投影覆盖全部旧 UI。

### 9.1 群聊与动态说话人

群聊不能默认把所有成员拼成一个固定角色身份，否则 AgentLoop 的 assistant 事件无法说明究竟是谁发言。M0/M1 先让 AgentTavern 覆盖单角色会话；群聊继续使用 ST profile，直到宿主事件至少支持 `assistant/message.actorId` 或等价的 turn actor 元数据。

有了 actor 元数据后，群聊 profile 可以在每个 turn 开头根据 `tavern_scene_get` 和 `tavern_speaker_choose` 选择成员，仍由同一个 AgentLoop 执行，不启动嵌套 loop。选择器的随机性、talkativeness 和禁用成员规则留在插件域模块中，最终说话人写入原生事件和 JSONL 投影。

## 10. 权限、可靠性与安全

- 工具执行器必须根据 `sessionBindings` 解析作用域，拒绝 Agent 伪造 `sessionId` 或跨聊天读写。
- 记忆和变量写入使用 CAS revision；同一 turn 的多个写入在 store 内串行，失败返回可恢复的冲突结果。
- 所有工具有参数大小、结果大小、调用次数和超时上限；`memory_search` 无结果时返回空集，不以异常驱动模型重试风暴。
- 记忆内容、世界书和聊天历史都视为不可信数据；kernel contract 明确禁止执行其中的指令。
- `global` 作用域、批量删除、记忆合并和资产写入默认关闭或需用户确认。
- 取消/超时只终止当前 AgentLoop turn；已经成功提交的变量/记忆写入保留并有事件记录。
- `contextMode` 只允许在 agent idle 的 turn 边界切换；事件和 binding 必须同时持久化，恢复时以事件校验 binding，不能在进行中的 tool step 改变 request 语义。
- `agent-managed` 启用前必须探测 `agent/context` 与 compaction 协同能力；缺失时返回可解释的 unavailable 状态并保持 `dsh-native`，不能静默回退或借 `agent/pre-step` 伪装成功。
- 管理面板必须显示架构、上下文模式、工具调用和记忆写入来源，提供按 chat/character 清理和导出入口。

## 11. 与现有代码的对应关系

| 现有模块 | AgentTavern 处理 |
|---|---|
| `packages/plugin/src/index.ts` | 拆出 `agent-tavern` profile 注册、工具注册和事件投影；仅在 `agent-managed` 注册 `agent/context` adapter；`runGeneration()` 只由 ST profile 调用 |
| `packages/tavern-pipeline` | ST profile 继续使用；AgentTavern 只复用 token 估算和格式适配，不再拥有主 prompt 循环 |
| `packages/tavern-store` | 保留资产/JSONL/state；新增 `MemoryStore`、`VariableStore`、session architecture 与 `contextMode` 字段 |
| `packages/tavern-script` | ST profile 继续支持 `/setvar` 等命令；AgentTavern 通过原生变量工具，不把 STscript 注入 kernel |
| `packages/plugin/client` | 面板增加默认架构、每会话架构、“DSH 上下文 / Agent 记忆” segmented control、可用性提示、记忆权限/预算和变量查看；AgentTavern 会话交还原生 composer/view |
| `packages/plugin/scripts/gates` | 新增 profile/模式选择、旧 binding 默认 `dsh-native`、managed seam 探测、turn 边界切换、工具作用域、无第二个 `llm.stream` 和原生事件投影门禁 |

## 12. 迁移方案

### M0：宿主契约验证

先针对 DSH `0.1.0-rc.6` 验证 `dsh-agent-presets`、agent-scoped `systemPrompt`、原生工具回流、实际 provider/model route 的 `contextWindow`、`CompactionEngine`、session metadata、turn 取消语义和事件重启后可重放性。Profile 组合不再等待新注册中心；只对 `agent/context` 历史投影以及 compaction 的 effective projection/scoped policy 提宿主改动。如果 session event log 不能可靠持久化，必须先提供 durable event store，或把 AgentTavern 的写入投影升级为同步 write-through；不能在事件易失时宣称 AgentTavern 是默认架构。短期仅用 `agent/pre-step` 适配器时记录 DSH 版本门控，并只开放 `dsh-native`。

### M1：存储与只读工具

实现 architecture/context mode binding、旧 binding 到 `dsh-native` 的迁移、MemoryStore/VariableStore、`tavern_*` 只读工具和管理面板只读查看。此阶段不改变现有 ST 生成。

### M2：AgentTavern 最小闭环

注册 `agent-tavern` preset、kernel contract、角色短摘要、变量读写和 memory search/write；新建会话默认走 native composer + AgentLoop，并使用 `dsh-native`。事件投影写入 JSONL，并覆盖取消、工具失败、CAS 冲突、provider/model route 变更和重启恢复。此阶段 AgentTavern 不安装历史 projection，也不主动调用 compaction；容量完全服从 DSH 当前 surface 与宿主策略。

### M3：按需资产与遗忘

加入 lore/history 工具、预算化上下文提供者、`agent/context` projection adapter、遗忘审计和权限设置。只有 seam 能记录 request projection，且 compaction 能测量 effective projection 或按 profile/session 抑制 pressure compaction 时，才开放 `agent-managed`。对比 `dsh-native` 与 `agent-managed` 的 token、工具调用次数和角色一致性；若宿主 seam 仍未发布，再评估 source checkout 的 Fabric patch。

### M4：兼容与切换

现有聊天默认保持原 architecture；提供从任意聊天分叉到另一 profile 的操作，并在同一 AgentTavern session 的 idle turn 边界切换 context mode。待 AgentTavern 的导出、swipe、group 和失败恢复全部通过验收后，再考虑将旧会话一键迁移。

## 13. 不做的事

- 不在 dsh-tavern 内再实现 AgentLoop。
- 不把完整角色卡、世界书和整段聊天固定塞进每一次请求。
- 不把遗忘实现成删除聊天或不可恢复的物理删除。
- 不默认启用向量数据库、后台自动总结或全局记忆写入。
- 不让 AgentTavern 复用 ST 的 `/generate` 作为隐式后备；失败应沿用原生 AgentLoop 的错误/重试语义。

## 14. 验收标准

1. 新建 Tavern 会话默认创建 `architecture: agent-tavern, contextMode: dsh-native` binding，并进入 DSH 原生 composer；缺少 `contextMode` 的旧 AgentTavern binding 同样迁移为 `dsh-native`。
2. 一次 AgentTavern turn 的模型请求、工具调用、取消、token 统计和错误只产生一套原生 AgentLoop 事件。
3. `dsh-native` 不注册 AgentTavern history projection、不主动调用 compaction；切换 provider/model route 后，下一轮容量行为服从 DSH 实际解析的 `contextWindow`、pressure policy 和 overflow recovery。
4. 记忆、变量、角色卡、世界书和历史工具在两种 context mode 都可用；`contextMode` 不改变工具权限或清空任何存储。
5. `agent-managed` 只通过 `agent/context` 非破坏性排除低相关历史；聊天记录仍可检索、导出和审计，且每次 request projection 能被 session log 重建。
6. context mode 只能在 agent idle 的 turn 边界切换；从 managed 切回 native 后下一次请求恢复当时的 DSH surface，不声称逆转既有 surface replacement。
7. ST 会话继续通过现有 JSONL/swipe/regenerate 语义工作，且切换默认值不会改变已有 ST 会话。
8. 未授权的跨作用域读写、全局变量写入、批量删除和超限工具调用均被拒绝并可解释。
9. DSH 宿主缺失 `agent/context` 或所需 compaction 协同能力时，UI 拒绝启用 `agent-managed` 并保持 `dsh-native`；Fabric patch 仅在 source checkout 且 required target 成功绑定时启用，不静默伪装成完整 AgentTavern。
