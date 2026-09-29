# dsh-tavern/agent 不再直读插件作用域的 ctx.agent（DSH 0.2.0-rc.2）

日期：2026-09-29。状态：已实施。

## Problem

在 DSH `0.2.0-rc.2` 上激活 AgentTavern 会话时，preset 声明行 `dsh-tavern-agent`
（模块 `dsh-tavern/agent`）挂载失败，宿主日志：

```
dsh-tavern-agent (dsh-tavern/agent): cannot get property "agent" without inject
```

根因是 `apply()` 的第一句 `const agentId = ctx.agent?.id`。宿主
`@deepseek-ai/cordis` 的 Context 代理对「既不在 ctx 目标对象上、也不是当前
fiber 可解析服务」的属性访问同步抛错（`internal/get` 通道走完仍无 provider
即抛），可选链不构成任何保护；`agent` 也不在本模块的 `inject` 声明里，宿主
侧更没有任何 provider 注册过名为 `agent` 的服务。apply 抛错即整个 preset
模块不挂载：kernel prompt section、facts context 与 15 个领域工具一并缺失。

实测（本机真实 cordis 挂载 HEAD 产物）：`error: cannot get property "agent"
without inject`，注册 0 项；修复后同一挂载点注册 kernel section、facts context
与 15 个工具、零错误日志。

## Decision

- **身份通道按层分开**：工具侧用 `exec.agent.id`（宿主 tool exec 上下文，
  早已如此）；prompt 侧用 `systemPrompt.context` 回调的入参
  `{ agent, scope, signal }`（`@deepseek-ai/dsh-agent` 的 `assembleContextFor`
  交回，首方插件 `dsh-user-approval` / `dsh-sandbox-policy` 同款写法）。
- facts 装载由「挂载期一次」改为「首次装配时一次」：语义等价（异步、
  best-effort、装载完成前返回空串），身份来自装配参数而非插件 ctx。
- 两个 preset 模块的 `AgentContextLike` 删除 `agent?: { id?: string }` 声明
  （novel 模块从未读过它）：接口不再暗示 `ctx.agent` 是挂载契约的一部分。
- 回归保护：`packages/plugin/tests/agent-tavern-mount.spec.ts` 用「未声明属性
  访问即抛」的代理 ctx 挂载模块；此后任何成员再把 agent 身份读回插件 ctx，
  测试立刻失败。

## Alternatives considered

- **把 `agent` 加进 `inject`**：宿主没有任何 provider 提供该服务（agent 注册
  在 `agents` 名下，且是根服务），声明只会让模块永远 pending——比抛错更糟，
  否决。
- **`ctx.get('agent')` / `try { ctx.agent } catch {}` 探测**：把真 bug 降级成
  静默无身份，facts 永远为空且无人察觉，同时继续掩盖「agent 身份不属于插件
  ctx 契约」这一事实，否决。
- **整块删除 facts context**：会丢掉每轮角色卡摘要的上下文投影，超出修 bug
  的范围，否决。

## Consequences

- preset 模块只触达声明过的服务（`systemPrompt`、`tools`）；新宿主形状接入
  前必须先在 gated ctx 上过一遍，`?.` 不是注入门的保护。
- 老宿主行为不变：装配上下文一直携带 `agent`，facts 语义与挂载期装载一致。
- 待办（未实施）：门禁目前只挂载主模块 `index.mjs`，可再补一条「preset 模块
  在真实 cordis 下 apply 成功」的挂载门禁，把这类模块级挂载失败拦在 CI。
