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
- `mountTransport`：`ctx.effect` 注册 web server 前缀路由——trust/origin、`frontend/idb/put` 的 raw body 例外、`handleApi`、结构化错误映射。

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
- Round 5 stage 1 定向：`im-router` 55 + `tavern-update` 55 + `games-service` 28 + `http-trust` 23 + `http-public-error` 7 = 168 用例通过；同一条 tsc 命令无输出。
- 全量 `pnpm run check`（2026-11-02，Round 4）：200 files / 3297 passed / 2 skipped / 20 gates PASS / build v0.7.5 (b095620)。
- Round 5 全量：宿主默认并行两次触发 `VirtualAlloc failed` / JS heap OOM（失败点与 route table 无关）；改用等价串行 `vitest run --no-file-parallelism` 后 **200 files / 3297 passed / 2 skipped**，类型检查、`build:plugin` 与 20 gates 全 PASS，build v0.7.5 (2d53ff0)。
- Round 6 stage 1 定向：`bootstrap-state-slices` 2 + `store-revision` 1 + `panel-regex-large-body` 1 + `helper-route` 40 + `http-trust` 23 + `http-public-error` 7 = 74 用例通过；额外 `tavern-mods` 78 通过（真实 `GET store-revision` 消费方）；同一条 tsc 命令无输出。
- Round 6 全量：`pnpm exec vitest run --no-file-parallelism` → **200 files / 3297 passed / 2 skipped**；`tsc -b`、security tsc、plugin tsc、`build:plugin` 与 20 gates 全 PASS，build v0.7.5 (88c1fca)。
- Round 7 stage 1 定向：`avatar-fallback` 5 + `tavern-command` 54 + `tavern-guides` 11 + `tavern-script-play` 14 + `agent-tavern-projector` 47 + `agent-tavern-mount` 2 + `tavern-mods` 78 + `agent-novel-command` 20 + `bootstrap-state-slices` 2 + `store-revision` 1 + `panel-regex-large-body` 1 + `http-trust` 23 + `http-public-error` 7 + `im-router` 55 = 320 用例通过；同一条 tsc 命令无输出。
- Round 7 全量：`pnpm exec vitest run --no-file-parallelism` → **200 files / 3297 passed / 2 skipped**；`tsc -b`、security tsc、plugin tsc、`build:plugin` 与 20 gates 全 PASS，build v0.7.5 (23da5cf)。
- Round 8 stage 1 定向：12 个 body 相关 spec（wiring 87 + runtime 87 + projector 37 + jsonl 35 + ledger 20 + client 19 + candidate-receipts 29 + mvu-rollback 8 + admission 14 + rollback 48 + display-route 8 + `tavern-command` 54）= 446 用例通过；同一条 tsc 命令无输出。
- Round 8 全量：`pnpm exec vitest run --no-file-parallelism` → **200 files / 3297 passed / 2 skipped**；`tsc -b`、security tsc、plugin tsc、`build:plugin` 与 20 gates 全 PASS，build v0.7.5 (a008bad)。
- Round 9 stage 1 定向：`card-workbench-plans` 31 + `tavern-assets` 23 + `avatar-fallback` 5 + `tavern-command` 54 + `tavern-guides` 11 + `tavern-mods` 78 + `im-router` 55 + `bootstrap-state-slices` 2 + `store-revision` 1 = 260 用例通过；独立复核另跑 `tavern-mods` 78 + `helper-route` 40，逐字比对 79/79 行一致；同一条 tsc 命令无输出。
- Round 9 全量：`pnpm exec vitest run --no-file-parallelism` → **200 files / 3297 passed / 2 skipped**；`tsc -b`、security tsc、plugin tsc、`build:plugin` 与 20 gates 全 PASS，build v0.7.5 (6cb3284)。
- Round 11 stage 1 定向：`avatar-fallback` 5 + `tavern-command` 54 + `card-workbench-plans` 31 + `tavern-mods` 78 + `im-router` 55 = 223 用例通过；独立复核另跑 90 用例并做 113/113 行逐字比对；同一条 tsc 命令无输出。
- Round 11 全量：`pnpm exec vitest run --no-file-parallelism` → **200 files / 3297 passed / 2 skipped**；`tsc -b`、security tsc、plugin tsc、`build:plugin` 与 20 gates 全 PASS，build v0.7.5 (54e74ff)。
- Round 12 stage 1 定向：`tavern-command` 54 + `card-workbench-tools` 9 + `agent-tavern-preset` 9 + `native-preset` 5 + `preset-mount` 7 + `tavern-assets` 23 + `im-router` 55 = 162 用例通过；独立复核另跑 84 用例并做 64/64 行逐字比对；同一条 tsc 命令无输出。
- Round 12 全量：`pnpm exec vitest run --no-file-parallelism` → **200 files / 3297 passed / 2 skipped**；`tsc -b`、security tsc、plugin tsc、`build:plugin` 与 20 gates 全 PASS，build v0.7.5 (26d20e9)。
- Round 13 stage 1 定向：`tavern-command` 54 + `agent-tavern-preset` 9 + `preset-mount` 7 + `native-preset` 5 + `card-scripts` 8 + `tavern-mods` 78 + `im-router` 55 = 216 用例通过；独立复核另跑 78 用例并做 1/1 + 21/21 + 94/94 行逐字比对；同一条 tsc 命令无输出。
- Round 13 全量：`pnpm exec vitest run --no-file-parallelism` → **200 files / 3297 passed / 2 skipped**；`tsc -b`、security tsc、plugin tsc、`build:plugin` 与 20 gates 全 PASS，build v0.7.5 (ba61c9b)。
- Round 14 stage 1 定向：`tavern-command` 54 + `agent-tavern-display-route` 8 + `card-workbench-p3` 14 + `session-binding-reclaim` 15 + `tavern-mods` 78 + `im-router` 55 = 224 用例通过；独立复核另跑 91 用例并做 127/127 行逐字比对；同一条 tsc 命令无输出。
- Round 14 全量：`pnpm exec vitest run --no-file-parallelism` → **200 files / 3297 passed / 2 skipped**；`tsc -b`、security tsc、plugin tsc、`build:plugin` 与 20 gates 全 PASS，build v0.7.5 (409f62b)。
- Round 15 stage 1 定向：`tavern-candidates` 22 + `tavern-mvu` 32 + `preview-generation` 6 + `mvu-undo` 17 + `card-workbench-plans` 31 + `tavern-mods` 78 + `im-router` 55 = 241 用例通过；独立复核另跑 77 + 52 用例并做 24/24 + 1/1 + 1/1 行逐字比对；同一条 tsc 命令无输出。
- Round 15 全量：`pnpm exec vitest run --no-file-parallelism` → **200 files / 3297 passed / 2 skipped**；`tsc -b`、security tsc、plugin tsc、`build:plugin` 与 20 gates 全 PASS，build v0.7.5 (8c4c3e8)。
- Round 16 风险修补：新增 `packages/plugin/tests/http-route-table.spec.ts` 8 条真实 `apply()` HTTP 用例——world import、persona/group CRUD、preset 写读、bindings/prune、branch、character export、`STORE_ROUTES` 顺序快照、错误方法回落 404。此前 persona/group 写路径、`import/world`、`GET preset/*`、`bindings/prune`、`branch`、`export/character` 的测试空白已补上。
- Round 16 全量：`pnpm exec vitest run --no-file-parallelism` → **201 files / 3305 passed / 2 skipped**；`tsc -b`、security tsc、plugin tsc、`build:plugin` 与 20 gates 全 PASS，build v0.7.5 (b79d8c1)。
- Round 17 风险修补：`http-route-table.spec.ts` 增加 `GET models` 目录、`POST model` 选择写入/清除，以及 `PUT models` / `GET model` 错误方法 404；models/model 的 HTTP 空白补齐。
- Round 17 全量：`pnpm exec vitest run --no-file-parallelism` → **201 files / 3306 passed / 2 skipped**；`tsc -b`、security tsc、plugin tsc、`build:plugin` 与 20 gates 全 PASS，build v0.7.5 (f2cb618)。
- Round 18 stage 1：`card-workbench/*`、`memory/embed*`、`memory/maintenance`、`prompts` 搬进 `packages/plugin/src/http/panel-management-routes.ts`；四个表项按旧 if-chain 顺序追加在 `mvu` 之后。复核发现 `http-route-table.spec.ts` 的顺序快照未同步，已补四个表项名后 9/9 通过。
- Round 18 全量：`pnpm exec vitest run --no-file-parallelism` → **201 files / 3306 passed / 2 skipped**；`tsc -b`、security tsc、plugin tsc、`build:plugin` 与 20 gates 全 PASS，build v0.7.5 (5db309f)。
- Round 19 stage 1：`world/*` 读/改/导出/删除与 preset delete/export 搬进 `packages/plugin/src/http/world-preset-routes.ts`；六个表项按旧 if-chain 顺序追加在 `prompts` 之后。复核补充了 world 读/导出/删除、preset 导出/删除与 `GET world` / `POST preset` 错误方法的 HTTP 用例；`http-route-table.spec.ts` 增到 11 条。
- Round 19 全量：`pnpm exec vitest run --no-file-parallelism` → **201 files / 3308 passed / 2 skipped**；`tsc -b`、security tsc、plugin tsc、`build:plugin` 与 20 gates 全 PASS，build v0.7.5 (94dbc15)。
- Round 20 stage 1：`variables` GET/PUT、`regex` GET/PUT、`import/regex`、`regex/sync-cards`、`regex/sync-presets` 搬进 `packages/plugin/src/http/variables-regex-routes.ts`；七个表项按旧 if-chain 顺序追加在 `preset-export` 之后。复核补充了 variables 读写、regex 读写、`import/regex` 与 `DELETE variables` / `POST regex` 错误方法的 HTTP 用例；`http-route-table.spec.ts` 增到 12 条。
- Round 20 全量：`pnpm exec vitest run --no-file-parallelism` → **201 files / 3309 passed / 2 skipped**；`tsc -b`、security tsc、plugin tsc、`build:plugin` 与 20 gates 全 PASS，build v0.7.5 (0f8ac5d)。

## 删除路径

把三个 phase 的函数体内联回 `apply()` 的原位置，删除 `mount.ts`；没有持久态、定时器、事件订阅或数据格式变化。回滚后残留为零。

## 未完成

- route table 十三刀已落（update / games / im；bootstrap / store-revision / state-slices；avatar / character 读 / projection / compact / guides / script / audit / novels / mods；body；character 写/删/导出；persona/group；asset import/preset；models/model/state；binding/chats/branch；candidates/preview/mvu；card-workbench/memory/prompts；world/preset delete/export；variables/regex）；其余 if-chain（helper/frontend/chat/generate 等）仍是后续。
- games / IM / Mods / update 仍留在 `index.ts`；它们各自有生命周期与 disposer，抽相位时要先定义清理顺序。
- `MountDeps` 只是阶段句柄，不是新的 service locator；静态协作者继续直接 import。

## 后续

- 路由表第一刀已完成（Round 5 stage 1）：`packages/plugin/src/http/routes.ts` 的 `PRE_STORE_ROUTES` 依次为 `update`（`route === 'update' || route.startsWith('update/')`）、`games`（`isGamesRoute`），在 `store()` 之前求值；`EARLY_STORE_ROUTES` 只有 `im`（`route === 'im' || route.startsWith('im/')`），在 `store()` 之后紧接求值。未命中任何表项的路由继续走 `handleApi` 原 if-chain，顺序与响应不变。
- 路由表第二刀（Round 6 stage 1）：三个 GET 读路由搬进 `packages/plugin/src/http/read-routes.ts`（`handleBootstrapApi` / `handleStoreRevisionApi` / `handleStateSlicesApi`），并在 `EARLY_STORE_ROUTES` 的 `im` 之后按 `bootstrap` → `store-revision` → `state-slices` 顺序挂表。`RouteEntry.matches` 改为 `(route, method)`，三条表项各自做 `method === 'GET'` 门控；非 GET 仍落回原 if-chain 的 404。`db = await store()` 位置不变。
- 路由表第三刀（Round 7 stage 1）：`avatar` / `character` 读 / `projection` / `projection/replay` / `compact` / `guides` / `script` / `agent-tavern/audit` 搬进 `packages/plugin/src/http/domain-routes.ts`，与 `novels` / `mods` 一起挂到新的 `STORE_ROUTES`。三个相位函数逐字搬迁（含注释与错误文案），表位置按原 if-chain 顺序。
- 路由表第四刀（Round 8 stage 1）：`handleAgentTavernBodyApi` 与 body-only helpers 搬进 `packages/plugin/src/http/body-api.ts`；`asRecord` / `asChatLog` 收进 `packages/plugin/src/http/json-records.ts`。`body` 条目插回 `STORE_ROUTES` 的原位置（audit 之后、novels 之前），条件与原 if-chain 等价；`router.ts` 保留同路径 re-export 供既有调用方。
- 路由表第五刀（Round 9 stage 1）：`PUT character/<name>` / `DELETE character?name=` / `GET export/character/<name>` 搬进 `packages/plugin/src/http/character-routes.ts`；三个表项按旧 if-chain 顺序追加在 `mods` 之后。逐字比对 79/79 行一致；导出路由的 `content-type` / `content-disposition` 未改。
- 路由表第六刀（Round 11 stage 1）：`import/persona`、`PUT/DELETE persona`、`GET persona-avatar/*`、`GET/POST groups`、`PUT/DELETE group` 搬进 `packages/plugin/src/http/persona-group-routes.ts`；八个表项按旧 if-chain 顺序追加在 `character-export` 之后。逐字比对 113/113 行一致；这些 persona/group 写路由此前没有 HTTP 级用例，本轮只做逐字搬迁，回归由全量与静态比对承担。
- 路由表第七刀（Round 12 stage 1）：`POST import/character`、`POST import/world`、`POST import/preset`、`GET preset/*`、`PUT preset/*` 搬进 `packages/plugin/src/http/asset-import-routes.ts`；五个表项按旧 if-chain 顺序追加在 `group-delete` 之后。逐字比对 64/64 行一致；`import/world` 与 `GET preset/*` 仍无 HTTP 级用例，静态比对承担回归证据。
- 路由表第八刀（Round 13 stage 1）：`GET models`、`POST model`、`POST state` 搬进 `packages/plugin/src/http/panel-state-routes.ts`；三个表项插回 `character-export` 之后、`persona-import` 之前，并把 Round 12 的 asset import 表项移到 persona/group 之前，使整张 `STORE_ROUTES` 恢复旧 if-chain 顺序。逐字比对 1/1、21/21、94/94 行一致。
- 路由表第九刀（Round 14 stage 1）：`POST/DELETE binding`、`POST bindings/prune`、`GET/POST chats`、`POST branch` 搬进 `packages/plugin/src/http/session-routes.ts`；六个表项按旧 if-chain 顺序追加在 `group-delete` 之后。逐字比对 127/127 行一致；`bindings/prune` 与 `branch` 仍没有 HTTP 级用例。
- 路由表第十刀（Round 15 stage 1）：`POST candidates`、`POST preview`、`MVU retry/undo/status` 搬进 `packages/plugin/src/http/generation-variable-routes.ts`；三个表项按旧 if-chain 顺序追加在 `branch` 之后，MVU 条件保留 `POST retry|undo + GET status/` 复合形态。逐字比对 24/24、1/1、1/1 行一致，原有中文注释随函数迁入。
- 剩余 if-chain 域（本刀未搬）：`card-workbench/*` / `memory/*` / `prompts` / `world/*` / `export/world` / `preset` delete/export / `variables` / `regex` / `helper*` / `generate` / `frontend/*` / `chat/*` / `display` 等；下一刀按 `store()` 依赖与顺序约束继续迁入表。
- 每增加一个 mount phase，必须在决策或代码注释里写明它相对于 body/anchor/prompt 的顺序约束；顺序不能只靠阅读调用栈。
