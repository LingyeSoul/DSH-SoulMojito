# 提案 0005：AgentNovel 全自动小说推演架构

> 状态：提议。日期：2026-09-11。前置提案：0004。关联决策：2026-09-10-subagent-deduction、2026-09-10-deduce-prefix-cache-reuse、2026-08-16-occupy-blank-session、2026-09-09-dsh-bind-library。

## 1. 结论先行

AgentNovel 是 dsh-tavern 的第三种会话架构 `agent-novel`：运行在 DSH 原生 AgentLoop 上的长篇小说自动写作 profile。它复用 AgentTavern 的资产模型（角色卡、世界书、记忆、变量、推演工具），新增三样东西：

1. **大纲（outline）作为唯一推进契约**——存 NovelStore，CAS 修订，driver 与模型只通过它对齐进度；
2. **NovelDriver**——一个不含 LLM 的会话级调度器，在 turn 边界用宿主 `Agent.followup()` 排队下一个写作单元，实现零人工干预的连续推进；
3. **作者语义的用户消息**——小说运行期间 composer 消息是创作指令（requirement），不是剧情内发言；模型收到后先修大纲再继续写。

```text
kickoff 用户要求（一条消息）
  -> DSH AgentLoop turn：调研资产 -> 生成大纲 -> novel_outline_write
  -> NovelDriver（无 LLM）：读大纲 -> followup(<novel_brief 第1章>)
  -> AgentLoop turn：调研 -> 写正文 -> 更新章节状态/记忆
  -> NovelDriver：读大纲 -> followup(下一单元)      ← 循环，无用户参与
  中途用户消息 -> 原生 inbox FIFO -> 模型先修订大纲再续写
完结（全部章节 final）-> driver 停止，产出 chapters/*.md
```

插件侧不出现第二个 LLM 循环：driver 只做事件监听、存储读取和 `followup()` 排队，所有生成仍由原生 AgentLoop 完成；`checkAgentTavernIsolation` 三禁同样覆盖 `src/agent-novel/`。这与宿主自带 `dsh-goal-round-driver` 用 `followup()` 驱动 goal rounds 是同一平台语义，不是新造的循环。

## 2. 问题边界

"全自动"拆成可验收的三条痛点：

| 痛点 | 本设计的回答 |
|---|---|
| 每章写完就停，要用户手动发"继续" | driver 在每个 turn/end 排队下一单元 brief（goal-round-driver 同型方案） |
| 模型中途向用户提问、等回答 | kernel 作者协议禁止提问；preset 工具面不含 ask-user 类工具 |
| 宿主重启或出错后静默死掉 | run 状态持久化，apply/`agent/created` 重臂；连续失败/停滞上限触发暂停并 surfaced |

以及一条正向需求：中途插入的新要求要"调整大纲 + 正在推演的后续剧情"，已写正文不被回改（详见 §7）。

## 3. 架构语言（提议并入 CONTEXT.md）

**AgentNovel**：运行在 DSH 原生 AgentLoop 上的小说自动推演 profile。它规定作者身份、大纲协议、工具权限和推进策略；推进由宿主 followup 语义承载，不拥有第二个执行循环。
_Avoid_：小说循环、自动续写器、Novel loop

**大纲**：小说会话的持久化推进契约，含章节列表、章节状态与修订日志。大纲是 driver 与模型之间唯一的进度事实来源。
_Avoid_：剧情记忆、章节数组（脱离 NovelStore 称呼时）

**写作单元**：一个 turn 承担的最小推进单位：开写一章、延续一章，或一次大纲修订。
_Avoid_：回合（与 RP turn 混淆）

**创作指令**：小说运行期间用户消息的语义——对大纲与后续剧情的要求，不是剧情内发言。
_Avoid_：用户发言、对话输入

**NovelDriver**：插件内会话级调度器。监听事件、读大纲、渲染 brief、排队 followup；不调用模型。
_Avoid_：生成循环、后台 worker

## 4. 会话模型与绑定

```ts
type TavernArchitecture = 'agent-tavern' | 'st' | 'agent-novel'

interface NovelSessionBinding {
  architecture: 'agent-novel'
  novelId: string
  character?: string     // 可选：以某角色卡为人物基底
  lorebooks: string[]    // 世界书集合
  chatId: string         // 记忆 chat 作用域，与 novelId 同值
}
```

- 独立 preset `agent-novel`（`agent-presets/agent-novel/`，挂载 `dsh-tavern/agent-novel` 模块），有自己的 kernel；不与 RP kernel 混用。
- composer 交还原生（同 agent-tavern）；Tavern 会话 tab 不挂载——小说的读模型是章节文件投影，不是 JSONL 聊天投影。
- 桥接命令 `/dsh-tavern-session` 的 payload 扩展 action：`novel-open`（novelId、character?、lorebooks[]）、`novel-pause`、`novel-resume`，仍 `recordInput: false`。
- 架构互斥沿用 `TavernArchitectureConflictError` 守卫：已有真实 turn 的会话不能改绑 `agent-novel`。从 RP 聊天分叉出小说会话时，原 JSONL 作为可检索历史导入（turn 0 坐标，沿用 import 契约）。

## 5. 大纲：唯一的推进契约

`packages/tavern-store` 新增 `NovelStore`，文件布局 `$DSH_HOME/tavern/novels/<novelId>/`：

```text
outline.json              大纲本体（CAS，sha16 revision）
run.json                  driver 运行状态
chapters/NNN-<slug>.md    正文投影（幂等，按 eventSeq）
```

outline.json 结构：

```jsonc
{
  "revision": "…",
  "title": "…", "premise": "…", "genre": "…",
  "requirements": [
    { "id": "R1", "text": "用户原话", "status": "active",
      "createdAt": "…", "appliedAtRevision": "…" }
  ],
  "chapters": [
    { "index": 1, "title": "…", "beats": "本单元要发生什么（≤2000 字符）",
      "status": "planned", "wordTarget": 3000, "file": "chapters/001-<slug>.md" }
  ],
  "revisionLog": [
    { "revision": "…", "cause": "kickoff | user-requirement:R2 | agent-refine",
      "summary": "改了什么", "at": "…" }
  ]
}
```

- 章节状态机：`planned → drafting → drafted → final`。driver 靠它决定下一个 brief 是"开新章/收尾"还是"延续 drafting"。
- `requirements` 是创作指令台账：kickoff 消息与每条中途用户消息各记一条；指令被后续指令显式取代时置 `retired`。active 指令逐条进入每个 brief 的固定段（前缀缓存友好）。
- 修订纪律：`drafted|final` 章节是既成事实（canon），用户指令只允许修改 `planned|drafting` 章节的 beats 以及后续章节的增删；每次修订必须落 revisionLog，cause 可追溯。
- 工具面：`novel_outline_read(selector?)`（按章节/范围读，带预算；无 selector 时默认当前章节 ±2 与台账摘要，不提供无界全量读）、`novel_outline_write(patch, expectedRevision)`（CAS；接受章节状态迁移、beats 修订、requirements 状态变化与章节文件映射写入）。

## 6. NovelDriver：无 LLM 的自动推进

`src/agent-novel/driver.ts`。每个 agent-novel 会话一个实例，事件驱动，agent 内串行（沿用 goal-round-driver 的 requestDrive 合并纪律）：

```text
on session/event（binding 为 agent-novel）:
  turn/end                                   -> schedule drive(agent)
  user/message(source.kind === 'user')       -> 记 pendingRequirement
  agent/inbox/*                              -> N0 核实排队消息落点事件后用于 pending 检测

drive(agent):   // 串行化；run.status !== 'active' 直接返回
  1. 失败/取消计数与停止条件判定（§11）
  2. outline = NovelStore.readOutline(novelId)
  3. 全部章节 final -> run.status = 'completed'，停止
  4. inbox 有未消费的真实用户消息 -> 本拍不排队（用户消息自己唤醒下一 turn）
  5. unit = outline 首个非 final 单元
       planned / drafted -> "开写第 N 章" / "收尾第 N 章" brief
       drafting          -> "延续第 N 章" brief
  6. message = createUserMessage({
       content: renderBrief(unit, run, outline),
       source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'novel-brief' } })
     ctx.agents.withoutInitiator(() => agent.followup(message))
  7. 持久化 run.json（lastQueuedTurn、pendingRequirement 清账）
```

- **brief 渲染**（纯函数，`outline.ts`）：固定头（作者身份与纪律：先调研后动笔、持久化章节状态与剧情记忆、禁止向用户提问、写作单元完成即结束 turn）→ active 创作指令逐条（稳定段）→ 变长尾（章节号/状态/beats/接续锚点）。共享前缀字节稳定、尾段追加，沿用 deduce 前缀缓存决策的纪律。
- **重臂**：插件 apply 时扫描 `run.json status === 'active'` 的绑定重臂 driver；`agent/created`（宿主重启后会话加载）同样重臂，必要时 `whenIdle()` 后补排队。重启丢失的未消费 followup 由持久化 run 状态重建，不依赖 inbox 跨重启持久性。
- **并发纪律**：只在 turn 边界排队；同一 agent 的 drive 调度合并；`followup` 抛错计一次失败（goal-round-driver 同款 try/catch + surfaced）。
- v1 不使用 `agent/turn-stopping` veto（避免单 turn 无界步进与 token 失控），也不使用 `steer`；两者记录为后续评估项。单元没写完 turn 就结束是无害的：下一个 brief 依据 outline 状态自然变成"延续"。

## 7. 中途插入新要求

时序依赖宿主 inbox 的 FIFO 语义（N0 验证项①）：

```text
turn N 运行中，用户在 composer 发"让女主提前黑化"
  -> 宿主把消息排入 next-turn 队列（原生行为，无需插件参与）
turn N end
  -> driver 检测到未消费用户消息 -> 本拍不排 brief
turn N+1（由用户消息驱动）
  -> kernel 作者协议：这是创作指令——
     1) novel_outline_write：指令入账 requirements（Rn），
        修改 planned/drafting 章节 beats、增删后续章节，
        落 revisionLog（cause: user-requirement:Rn）
     2) 继续当前写作单元：把指令消化进自然延续，按新方向推进；
        不改写 drafted|final 正文
turn N+1 end -> driver 恢复正常链接
```

kernel 对应条款（作者协议）："小说运行期间的用户消息是创作指令，不是剧情内发言。收到后先修订大纲再继续写作；把指令消化进当前单元的自然延续，而不是中断叙事另起炉灶。若指令与已定稿内容冲突，调整后续章节并在大纲修订说明中记录权衡，不回改正文。"

## 8. Kickoff 与大纲生成

- 入口一（面板）：新建小说表单（角色/世界书多选、体裁、目标章节数、要求文本）→ 创建会话、绑定架构，由客户端把要求作为首条真实用户消息发出（或预填 composer 由用户回车发送）。
- 入口二：在 agent-novel 会话的 composer 直接输入要求，首条用户消息即 kickoff。
- kickoff turn 的协议：用 `tavern_character_get` / `tavern_lore_search` 调研人物与世界基底 → 产出大纲（标题/前提/主题/人物弧线/章节列表，章节数受 `novel.maxChapters` 配置约束）→ `novel_outline_write` 全量落盘 → 可写一个冷开场。turn 结束后 driver 接管。
- `novel.outlineApproval: 'auto'（默认） | 'manual'`：manual 时 driver 在大纲完成后暂停，等用户一条"开始"再推进。这是显式 opt-in 的干预点，默认关闭以守住"零干预"承诺。

## 9. 工具面

| 组 | 工具 | 与 AgentTavern 的关系 |
|---|---|---|
| 小说 | `novel_outline_read` / `novel_outline_write` | 新增；绑定解析复用 `bindingFor`（扩展接受 agent-novel） |
| 资料只读 | `tavern_character_get` / `tavern_lore_search` / `tavern_history_search` / `tavern_scene_get` | 复用 |
| 记忆 | `memory_search` / `memory_read` / `memory_write` / `memory_update` / `memory_forget` | 复用；chat 作用域解析为 novelId |
| 变量 | `variable_get` / `variable_set` / `variable_patch` / `variable_delete` / `variable_list` | 复用；turn 作用域清理同现有 |
| 推演 | `tavern_deduce` | 复用；kernel 建议在重大剧情转折前做沙盘推演 |

- preset 不注册任何用户阻塞型工具（ask-user 类）；若宿主默认工具面注入之，以 toolFilter deny 对冲（N0 核实项③）。
- 隔离 gates（`checkAgentTavernIsolation`）把 `src/agent-novel/` 纳入三禁：`llm.stream`、`runGeneration`、ST prompt pipeline。driver 只触 `followup`，天然满足。

## 10. 产出投影

`src/agent-novel/projector.ts`，沿用 AgentTavern projector 的全部纪律（事件驱动、eventSeq 幂等、checkpoint、CAS 重试、`agent/created` replay、失败置 pending 上面板）：

- 投影对象：无 tool-call 块的最终 `assistant/message` → 追加进 `chapters/NNN-<slug>.md`（按 outline 章节归属；drafting 延续段追加到同一文件）。
- 过滤：`source.kind === 'plugin'`（novel-brief、anchor）与用户消息不进正文。
- 章节文件映射由 driver/模型经 `novel_outline_write` 写入 `chapter.file`，投影器只认 outline 映射，不自作命名。
- 导出：面板一键打包 outline + chapters（zip）。

## 11. 可靠性、预算与安全

| 停止条件 | 行为 |
|---|---|
| 全部章节 final | `completed`，正常完结 |
| 面板 Stop / `novel-pause` | `paused(user)`；driver 不再排队，Resume 重臂 |
| turn 以 cancelled 结束且无 pending 用户消息 | `paused(user-cancel)`——用户主动干预即让路 |
| 连续 `maxConsecutiveFailures`（默认 3）个 error turn | `paused(errors)`，surfaced 原因 |
| 连续 `maxStalledTurns`（默认 3）turn 无进度 | `paused(stalled)`；进度 = outline revision 变化 ∨ 章节文件增长 ∨ 记忆审计新增（全部插件侧可观测，无需 LLM） |
| `novel.maxTurns`（可选，默认不限） | `paused(budget)`，面板一键续 |

- 所有 brief/notice 都是 logged user message（plugin source），走 sanctioned channel；不伪造 assistant 事件。
- 大纲、run、章节文件全部 CAS/幂等；driver 崩溃至多重复排队一个 brief，而 kernel 的"读大纲再动笔"纪律使重复 brief 无害（幂等推进）。
- 记忆/变量写入沿用 AgentTavern 权限模型（global 写入默认关闭）。
- 上下文容量完全服从宿主 surface/compaction 策略（与 dsh-native 同款立场）；长篇必然触发 compaction，见 §12。

## 12. 记忆与 compaction

- 记忆作用域：chat=novelId 存剧情事实与人物状态迁移；character 作用域仍指向角色卡（小说与 RP 共享人物正典）；默认只写 chat 作用域。
- `TavernCompactionCurator` 增加小说分支：checkpoint 模板含章节进度（curator 侧从 NovelStore 注入快照）/ 主线与伏笔 / 人物状态 / active 创作指令 / 文风与叙事视角约束 / 关键既成事实。沿用"同语言、verbatim 名称、不发明、不提及压缩机制"规则。
- 章节正文的完整事实来源是 `chapters/*.md` 投影与 session log；compaction 只影响上下文投影，不消灭小说本体。

## 13. 宿主 seam 核查

| 需求 | DSH 原生能力（0.1.2 已核） | AgentNovel 用法 |
|---|---|---|
| 自动续 turn | `Agent.followup(UserMessage)`（runtime-types.d.ts:118） | turn 边界排队写作单元 |
| 中途吸收 | 原生 composer → inbox FIFO；`Agent.steer()`（:126） | 用户消息自然排队；v1 不用 steer |
| 空闲同步 | `Agent.whenIdle()`（:90） | 重臂后等待 settle |
| 发起方隐藏 | `ctx.agents.withoutInitiator`（goal-round-driver 同款） | driver 排队不标记 initiator |
| 消息构造 | `createUserMessage`（`@deepseek-ai/dsh-llm`） | 经 bind `importHostPackage` 取宿主同源实例 |
| 事件观察 | `session/event` + `agent/inbox/*` + `agent/status` | driver 触发面 |
| 不停机 veto | `agent/turn-stopping`（:305） | v1 不用，评估记录 |

能力探测 fail-closed：绑定时探测 `typeof agent.followup === 'function'`；缺失则拒绝创建 agent-novel 会话，原因并入 bootstrap 端点的 capability 报告（沿用 `agentTavern` 字段模式，新增 `agentNovel`）。不 inject 声明、不做版本号判断——bind 库纪律。

N0 待核实项：① followup 排队消息与 composer 提交的 FIFO 顺序保证；② 排队未消费 followup 的重启持久性（设计不依赖，run.json 重建）；③ 宿主默认工具面是否含用户阻塞工具；④ `withoutInitiator` 精确语义。

## 14. UI（v1 最小面）

- 管理面板：小说列表（状态徽章：outlining / writing ch3/12 / paused+原因 / completed）、大纲查看、Pause/Resume、导出 zip。
- 会话头：复用 `conversation.session.header.actions` 槽位显示 novel 徽章（TavernHeaderAction 同型）。
- 新建表单：角色/世界书多选、体裁、目标章节数、要求文本框。
- i18n 按 locale-following 决策处理。

## 15. 里程碑

- **N0 宿主契约验证**：对 0.1.2 实测 followup/FIFO/重启持久性/默认工具面/withoutInitiator，写探针脚本落 `docs/exploration/`。
- **N1 存储与工具**：NovelStore、`novel_outline_*` 工具、binding 类型与冲突守卫、gates 扩展（run.mjs 含 NUL 字节，用 Python 编辑）。
- **N2 preset 与协议**：agent-novel preset、kernel（作者协议）、kickoff 大纲生成。无 driver 时可手动逐 turn 使用——降级形态是一台"小说家聊天"，独立可用。
- **N3 自动推进**：NovelDriver、brief 渲染、用户指令吸收、重启重臂、全部停止条件。
- **N4 投影与面板**：chapters 投影、compaction 小说模板、面板与导出。

## 16. 不做的事

- 不在插件内做任何 LLM 调用或第二执行循环；"自动"只存在于 followup 排队。
- 不用 `agent/turn-stopping` 强撑单 turn 无界步进。
- 不把完整大纲塞进每请求固定 prompt（按需经工具读取；brief 只带当前单元）。
- 不自动改写已 drafted/final 正文来迎合新指令；改历史的正道是从 chapters 投影分叉新会话。
- v1 不做 continuable 编辑子 Agent（`startContinuable`/`sendMessage` 留作后续"审稿人"扩展）、不做自动修订 pass、不做向量检索。
- 不依赖 ask-user 类工具推进剧情。

## 17. 验收标准

1. kickoff 一条消息后全程零干预：大纲生成 → 逐章推进 → completed，无任何"等待继续"停顿；期间模型不向用户提问。
2. 运行中发送新要求：当前单元完成后被吸收——requirements 台账入账、大纲修订落 revisionLog、后续章节按新方向推进、已写正文未被改写。
3. 宿主重启后 active 运行自动恢复推进；driver 崩溃不产生重复正文（幂等投影验证）。
4. 取消/连续失败/停滞任一停止条件触发后 driver 不再排队，面板 surfaced 原因；恢复需显式操作。
5. 全程只有原生 AgentLoop 事件；`src/agent-novel/` 通过三禁 gates。
6. 缺 followup seam 的宿主上拒绝创建 agent-novel 会话并给出可解释原因，不静默降级。
7. outline 与 chapters/*.md 可完整导出；brief/plugin 消息不出现在正文中。

## 18. 与现有代码的对应关系

| 模块 | 变更 |
|---|---|
| `packages/plugin/src/index.ts` | 桥接命令 novel-* action、capability 探测、driver 重臂、compaction 分支接入 |
| `packages/plugin/src/agent-novel/`（新） | `agent.ts`（preset 模块：kernel + 工具注册）、`driver.ts`、`outline.ts`（brief/协议纯函数）、`projector.ts` |
| `packages/plugin/src/agent-tavern/agent.ts` | `bindingFor` 扩展接受 agent-novel；工具集复用导出 |
| `packages/tavern-store` | `NovelStore`（`novel.ts`）：outline/run/chapters，CAS + 审计 |
| `packages/plugin/agent-presets/agent-novel/`（新） | `preset.yml` + `agent.cordis.yml` |
| `packages/plugin/client/main.js` | 新建小说表单、面板列表/Pause/Resume/导出、会话头徽章 |
| `packages/plugin/scripts/gates/run.mjs` | isolation 三禁覆盖 `src/agent-novel/`；新 preset 工件漂移检查 |
| 测试 | `agent-novel-{driver,outline,projector}.spec.ts`；mutating 用例按共享状态纪律放最后 |
