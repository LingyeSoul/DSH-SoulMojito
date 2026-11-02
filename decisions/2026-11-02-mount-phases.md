# 决策：`apply()` 装配阶段抽取（mount phases 首刀）

> 日期：2026-11-02。状态：已实施（stage 1：session / agent / transport 三相位；路由表与 games/IM/mods 相位待续）。范围：架构审查候选 03。相关：`packages/plugin/src/index.ts`、`packages/plugin/src/mount.ts`、`packages/plugin/tests/http-trust.spec.ts`、`packages/plugin/tests/http-public-error.spec.ts`、`decisions/2026-11-02-variable-gateway.md`。

## 问题

`apply()` 是 413 行的程序式装配中心：body projection、anchor、prompt capture、projector、`session/event`、`agent/created`、systemPrompt section、games、IM、Mods 与 HTTP transport 全部按行号顺序堆在一个函数里。顺序本身是契约（body 必须先挂、anchor 必须先于 prompt capture、Mods 必须等 games 落定），但只写在注释里；新增一个域要回到同一个函数里找插入点。

候选 03 的完整目标是 mount plan + route modules。本决策只做第一刀：把最独立的三个注册块抽成命名 phase，建立 `MountDeps` 与调用顺序，不改路由 if-chain。

## 阶段

`packages/plugin/src/mount.ts`：

```ts
export interface MountDeps {
  readonly store: () => Promise<TavernStore>
  readonly variables: () => Promise<VariableStore>
  readonly memories: () => Promise<MemoryStore>
  readonly memoryVectors: () => Promise<MemoryVectorStore>
  readonly bodyWiring: BodyWiringContext
  readonly getAgentTavernProjectorPromise: () => Promise<AgentTavernProjector> | undefined
  readonly getImRuntime: () => ImRuntime | undefined
  readonly allowedHosts: readonly string[]
}

export function mountSessionEvent(ctx: PluginContext, deps: MountDeps): void
export function mountAgentCreated(ctx: PluginContext, deps: MountDeps): void
export function mountTransport(ctx: PluginContext, deps: MountDeps): void
```

- `mountSessionEvent`：`session/event` 单订阅——projector 投影、`turn/end` 清 turn 作用域、AgentNovel receive barrier。
- `mountAgentCreated`：`agent/created` 单订阅——宿主分叉收养、projection replay、body recovery、IM preset 切换。
- `mountTransport`：`ctx.effect` 注册 web server 前缀路由——trust/origin、`frontend/idb/put` 裸体例外、`handleApi`、结构化错误映射。

`MountDeps` 只收有状态句柄；纯协作者（`adoptAgentTavernFork`、`bindSession`、`handleNovelSessionEvent`、`handleApi`、`requestTrustFailure` 等）由 `mount.ts` 直接 import。没有 `any`、没有默认参数。

## 顺序

`apply()` 仍按原顺序调用：`mountSessionEvent` → `mountAgentCreated` → `mountTransport`。三处调用位置与旧注册点一一对应，中间没有插入其他注册。`mountTransport` 仍在 `apply()` 末尾注册，`API`、`kind: 'prefix'`、`path` 与 effect 标签不变。

## 行为保持

- 三块源码与 HEAD 逐行机械比对：19/19、50/50、41/41 行一致；唯一差异是 `deps.` 限定。
- 日志字符串、注释、effect 标签、事件名、HTTP trust 分支、`frontend/idb/put` 特判全部保留。
- `http-trust.spec.ts` 与 `http-public-error.spec.ts` 的 source-check 改读 `mount.ts`；`normalizeAllowedHosts(config.allowedHosts)` 仍查 `index.ts`。这是断言位置迁移，不是弱化测试。
- `agent-novel-command.spec.ts` 用 fake `webServer.register` 捕获真实 handler，覆盖 apply 的 transport 接线。

## 验证

- 定向：`http-trust` 23 + `http-public-error` 7 + `agent-tavern-mount` 2 + `agent-tavern-fork` 15 + `agent-tavern-projector` 47 + `agent-novel-command` 20 = 114 用例通过。
- 类型检查：`node node_modules/typescript/bin/tsc -p packages/plugin/tsconfig.json --noEmit --composite false` 无输出。
- 全量 `pnpm run check`（2026-11-02，Round 4）：200 files / 3297 passed / 2 skipped / 20 gates PASS / build v0.7.5 (b095620)。

## 删除路径

把三个 phase 的函数体内联回 `apply()` 的原位置，删除 `mount.ts`；没有持久态、定时器、事件订阅或数据格式变化。回滚后残留为零。

## 未完成

- `handleApi` 的 85 个 route 判断仍是 if-chain；route modules / route table 是候选 03 的下一刀。
- games / IM / Mods / update 仍留在 `index.ts`；它们各自有生命周期与 disposer，抽相位时要先定义清理顺序。
- `MountDeps` 只是阶段句柄，不是新的 service locator；静态协作者继续直接 import。

## 后续

- 下一刀优先做 route table：把 `handleApi` 的域分支（update / games / im / panel / novel）注册成小表，再逐域搬 handler；transport 已独立，不再和路由混在一个函数里。
- 每增加一个 mount phase，必须在决策或代码注释里写明它相对于 body/anchor/prompt 的顺序约束；顺序不能只靠阅读调用栈。
