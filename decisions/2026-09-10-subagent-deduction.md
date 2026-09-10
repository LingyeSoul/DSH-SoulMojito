# 基于 SubAgent seam 的多Agent推演工具（tavern_deduce）

日期：2026-09-10。状态：已实施。

## Problem

用户要求在 SubAgent 可用的新版 DSH（0.1.2+，`ctx.subagents` capability seam +
in-process `spawn`/`fork` 驱动）上做多Agent推演：角色扮演中"如果这样发展，
各方会怎么反应、局势如何演变"的沙盘模拟。此前 AgentTavern 只有一个主循环，
多视角推演只能靠模型在单次生成里自我分饰，视角之间没有真实的独立推理。

## Decision

- **落点是一个工具，不是一条新链路**：`tavern_deduce` 注册进 AgentTavern
  作用域工具集（`agent-tavern/agent.ts`），推演核心在 `agent-tavern/deduce.ts`。
  不做 client UI、不做新 preset、不改 commands——主 Agent 是唯一叙事者，
  工具只回传结构化站位。
- **spawn 一次性子 Agent，不用 continuable**：spawn 不携带父会话上下文
  （角色只看场景与角色简报，避免剧情泄渗与 token 浪费），跨轮交叉推演由
  deduce.ts 无状态维护 transcript（第 r 轮 prompt 携带此前全部站位），
  不依赖 sessionPersistence。每个 run 在 settle 后立即 dispose（finally），
  结果 promise 不 reject，按 `stopReason` 分流。
- **子 Agent 纯推理**：`toolFilter: { allow: [] }` 清空工具，防止推演角色
  写记忆/改变量污染正典。子 Agent 会经 `composeFrom` 继承父 preset 的
  prompt 组合（含 KERNEL），角色 prompt 显式声明"工具不可用、不得提及推演
  机制"对冲；这是宿主 spawn 语义的平台级行为，不在插件侧绕开。
- **故障隔离**：单角色非 `completed` 或空输出只进 `failures`，其余角色继续；
  全员失败才抛错。abort 语义：`exec.signal` 直传 request.signal，轮间
  `throwIfAborted`，已启动 run 一律 dispose。
- **预算**：角色 2-5（唯一名），轮次 1-3（默认 1），单站位截断 4000 字符并
  置 `truncated`。显式不给 `maxDepth`（子深度=父+1，传 0 会直接
  `SubagentDepthError`）；子 Agent 无工具，天然无法再派生。
- **运行时探针，不 inject 声明**：`subagentRuntimeOf` 从 `exec.agent.ctx`
  先读 `subagents` 属性、再回退 `ctx.get('subagents')`；未部署 dsh-subagent
  时明确报错。与 bind 库的宿主形状探测同纪律。

## Consequences

- 推演质量取决于主 Agent 的角色归纳；KERNEL 不加推演职责条款，靠工具
  description 自述触发时机，避免改变所有会话的默认行为。
- 子 Agent 继承父 preset 组合带来的额外 system prompt 是接受的 token 成本；
  若宿主未来在 seam 上提供"裸子 Agent"能力，可只删角色 prompt 里的对冲句。
- gates `checkAgentTavernIsolation` 对 `src/agent-tavern/` 的三禁
  （`llm.stream`/`runGeneration`/ST prompt pipeline）天然满足：推演完全
  借道宿主 AgentLoop。
