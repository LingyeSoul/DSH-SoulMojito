# 决策：变量语义的单一 owner（Variable Gateway）

> 日期：2026-11-02。状态：**Phase 1 与 Phase 2 已实施（含 `body-rollback-receipts.ts` 的 gateway 收口）**。范围：架构审查候选 01。相关：`packages/plugin/src/helper.ts`、`packages/plugin/src/mvu.ts`、`packages/plugin/src/agent-tavern/mvu-compat.ts`、`packages/plugin/src/generation/pipeline.ts`、`packages/plugin/src/http/panel.ts`、`packages/tavern-store/src/variable.ts`、`packages/tavern-store/src/store.ts`；约束来源：`decisions/2026-10-11-mvu-receipt-undo.md`、`decisions/2026-10-20-frontend-helper-compat.md`、`decisions/2026-10-11-mvu-rules.md`、`decisions/2026-10-11-mvu-schema-guard.md`、`decisions/2026-10-28-agent-tavern-body-write-rollback.md`。

## 问题

“变量”是一个领域概念，但现在有三份存储、至少六个写入/读取入口，每个入口自己决定权威源、合并顺序、是否镜像与是否过 guard。

三份存储：

| 存储 | 内容 | 当前主要入口 |
| --- | --- | --- |
| 聊天 JSONL `chat_metadata.variables` | ST 架构的聊天变量树 | `helper.ts`、`generation/pipeline.ts`、`mvu.ts` |
| chat 作用域 `VariableStore` | AgentTavern 的扁平点分名变量 | `agent-tavern` 工具、`mvu.ts`、`helper.ts` |
| `state.json` 的 `scriptGlobals` / `characterVariables` / `frontendStorage` | global / character 覆盖层 / 前端存储 | `helper.ts`、`generation/pipeline.ts`、面板路由 |

入口与策略分叉：

- 读路径 `helper.ts:668-674`（`readChatScope`）先取 `chat_metadata.variables`，仅在 AgentTavern 绑定时叠加 flat `VariableStore`。
- 写路径 `helper.ts:676-730`（`replaceVariables`）按 scope 分三支：global 写 `state.scriptGlobals`，character 写 `state.characterVariables`，chat 写 JSONL 并在 AgentTavern 绑定时镜像到 `VariableStore`。
- 镜像函数在 `helper.ts:779-790`（`mirrorChatScope`）；失败被 `helper.ts:713-720` 的 `console.warn` 吞掉，聊天主写入仍成功。
- MVU 结算在 `pipeline.ts:862-865` 整树回写，再在 `pipeline.ts:873-879` 做 `$schema` guard 与 `$rules`。
- MVU 撤销有两条执行核：ST 在 `mvu.ts:941-960`（`undoMvuStSettlement`），AgentTavern 在 `mvu.ts:969-1017`（`undoMvuAgentSettlement`）；两者都调用 `screenMvuUndoRestores`（`mvu.ts:952` / `:990`）。
- body 路径在 `body-candidate-receipts.ts:376`、`body-rollback-receipts.ts:146-147`、`body-runtime-settlement.ts:1195` 调 `undoMvuReceipts`（`mvu.ts:1216-1239`）；这条路径直接 `plan → apply`（`mvu.ts:1231-1234`），**不调用** `screenMvuUndoRestores`。
- JSR 兼容层在 `agent-tavern/mvu-compat.ts:82-90` 与 `:120-153` 维护第三套 `stat_data` 写入/读取。
- 面板 `http/panel.ts:277-323` 的 undo 路由自己按 binding 选 ST / Agent 执行核；`http/panel.ts:332-371` 的 status 路由自己再判一次 binding。

有两处已经出现可核对的不一致：

1. **binding 判定不一致**：`helper.ts:816-819` 的 `isAgentTavernBound` 只比较 `chatId`；`http/panel.ts:296-297` 与 `:343-344` 同时比较 `character` + `chatId`。chatId 跨角色重名时，helper 可能把某个 chat 误判为 AgentTavern 绑定，从而读错叠加层或写错镜像目标。
2. **undo guard 不一致**：同一个“撤销上一轮变量”动作，面板路径受 `$schema` 约束，body 路径不受。schema 在结算后发生变化时，body 回滚可能恢复出当前 guard 会拒绝的 before 值，终态取决于从哪个入口进入。

这不是“存储选错了”的问题。既有决策明确要求按架构分工：`decisions/2026-10-11-mvu-receipt-undo.md:20` 规定 ST 写 `chat_metadata.variables`、AgentTavern 写 chat 作用域 `VariableStore`；`decisions/2026-10-20-frontend-helper-compat.md:16` 规定 Tavern store、chat 作用域 `VariableStore`、`state.scriptGlobals` 与客户端 `sessionBindings` 是各自的唯一事实来源。要统一的是**策略**——谁决定权威源、怎么合并、何时镜像、失败怎么报、undo 是否过 screen——不是把三份存储合成一份。

## 结论

引入一个 server 侧 **Variable Gateway**，作为变量语义的唯一 owner：

- **A1**：v1 覆盖 `chat` 的读写/镜像，以及 `character` / `global` 的存储路由；`message`、`turn`、`agent` 继续留在原入口。
- **B1**：chat JSONL 仍是权威；flat `VariableStore` 镜像有界重试，最终失败降级为可观察的 `mirror: degraded` receipt，不阻断主写入。
- **C1**：body 回滚与面板撤销共用同一条 `plan → screen → apply` 序列；`screenMvuUndoRestores` 不再有例外。
- **D1**：Strangler 迁移，先把现有函数包进 gateway，再逐步搬逻辑，最后删旧路径。

Gateway 不是第四份存储，也不是新的 service locator。它是纯策略模块：无状态、无 module 级缓存，只依赖注入的 store / variables / binding 查询。

## 作用域矩阵（v1）

| scope | ST 绑定 | AgentTavern 绑定 | gateway read | gateway replace |
| --- | --- | --- | --- | --- |
| `chat` | `chat_metadata.variables` | `chat_metadata.variables` + flat `VariableStore` 镜像 | 基础树；绑定时叠加 flat 条目 | 写 JSONL；绑定时镜像 flat；空树删键 |
| `character` | `state.characterVariables[character]` 覆盖卡内 `extensions.variables` | 同左 | 覆盖层优先，否则卡内树 | `state.updateState` 写覆盖层 |
| `global` | `state.scriptGlobals` | 同左 | `state.scriptGlobals` | `state.updateState` 写 `scriptGlobals` |
| `message` | `message.variables` | 同左 | **不在 v1** | **不在 v1**；仍由 helper 处理 |
| `turn` / `agent` | flat `VariableStore` | flat `VariableStore` | **不在 v1** | **不在 v1**；仍由变量工具处理 |

## Module 形状

```ts
import type { ChatLogIR, TavernSessionBinding, TavernStore, VariableStore } from '../../tavern-store/src/index.js'
import type { JsonValue } from '../../tavern-store/src/variable.js'
import type { MvuReceipt, MvuUndoRestore } from './mvu.js'

export type VariableRef =
  | { readonly kind: 'chat'; readonly character: string; readonly chatId: string }
  | { readonly kind: 'character'; readonly character: string }
  | { readonly kind: 'global' }

export type VariableTree = Readonly<Record<string, JsonValue>>

export type MirrorOutcome =
  | { readonly status: 'ok' }
  | { readonly status: 'degraded'; readonly reason: string }
  | { readonly status: 'not-applicable' }

export interface VariableWriteReceipt {
  /** Chat save revision; absent for character/global state writes. */
  readonly revision?: string
  /** Chat floor count at the save; absent for character/global state writes. */
  readonly floorCount?: number
  readonly mirror: MirrorOutcome
}

export interface UndoGuard {
  readonly schema: Record<string, unknown> | undefined
  readonly currentOf: (path: string) => unknown
}

export interface StagedUndo {
  readonly chat: ChatLogIR
  readonly receipts: readonly MvuReceipt[]
  readonly restores: readonly MvuUndoRestore[]
}

export interface UndoResult {
  readonly receipt: MvuReceipt
  readonly revision: string
  readonly restores: readonly MvuUndoRestore[]
}

export interface VariableGateway {
  read(ref: VariableRef): Promise<VariableTree>
  replace(ref: VariableRef, tree: VariableTree): Promise<VariableWriteReceipt>
  mirror(ref: Extract<VariableRef, { readonly kind: 'chat' }>, tree: VariableTree): Promise<MirrorOutcome>
  applyUndo(chat: ChatLogIR, receipts: readonly MvuReceipt[], guard: UndoGuard): StagedUndo
  undo(ref: Extract<VariableRef, { readonly kind: 'chat' }>): Promise<UndoResult>
}

export interface VariableGatewayDeps {
  readonly store: () => Promise<TavernStore>
  readonly variables: () => Promise<VariableStore>
  readonly bindingOf: (character: string, chatId: string) => Promise<TavernSessionBinding | undefined>
  readonly logger: { readonly warn: (message: string, fields: Record<string, JsonValue>) => void }
}

export function createVariableGateway(deps: VariableGatewayDeps): VariableGateway
```

Phase 1 落地 `read` / `replace` / `mirror`；Phase 2 落地 `applyUndo` / `undo`。`applyUndo` 是给 body 的内存态回滚：`structuredClone` 后调用 `undoMvuReceipts`，返回新的 `ChatLogIR`，不改输入，供 candidate edit 与 runtime settlement 暂存后再由调用方做单次 CAS 保存。`undo` 是给面板的持久化回滚：只收 `ref`，快照由 gateway 自己读取，ST / AgentTavern 执行核各自构造 guard；它不接受调用方传入的回执或 guard，避免两个入口各拼一套 screen。

> **实施状态**：`variable-gateway.ts` 已实现 `read` / `replace` / `mirror` / `applyUndo` / `undo`。面板 `POST mvu/receipts/undo`、`body-candidate-receipts.ts`、`body-runtime-settlement.ts` 与 `body-rollback-receipts.ts` 均已迁移；`body-rollback-receipts.ts` 用 `applyVariableUndo` 暂存后把新树就地接回原 chat，保持调用方的 in-place 契约。`UndoGuard`、`MvuReceipt`、`MvuUndoRestore` 仍由 `mvu.ts` 导出。

`read` 返回归一化后的 `VariableTree`；JSON 边界用运行时校验拒绝非 JSON 值，不用 `unknown` 贯穿内部。

## Seam 后面放什么

| Seam 后面 | 具体 adapter |
| --- | --- |
| chat 存储 | `TavernStore.getChatSnapshot` / `saveChat` |
| flat chat scope | `VariableStore.listAll` / `patch` / `delete` |
| character 覆盖层 / global | `TavernStore.updateState` |
| binding 判定 | `state.sessionBindings`，必须同时匹配 `character` 与 `chatId` |
| mirror 树 → flat 条目 | 从 `helper.ts:798-814` 移入纯模块的 `variableEntriesForMirror` |
| schema screen | `screenMvuUndoRestores`（纯函数，`undoMvuReceipts` 与 ST/Agent 执行核内部调用） |
| 回执账本 | `readMvuReceipts` / `recordMvuTurnReceipt`，继续留在 `mvu.ts` |
| JSR / ST wire shape | 继续留在 `helper.ts`；gateway 只收归一化后的树 |
| 模板 local/global 合并 | 继续留在 `generation/pipeline.ts`；gateway 收最终树 |
| `$schema` / `$rules` 结算 guard | 继续留在 `pipeline.ts` / `mvu.ts`；gateway 不重复跑 |

## 关键契约

### 1. binding 必须按 `(character, chatId)` 判定

Gateway 的 `bindingOf(character, chatId)` 必须同时匹配两个字段。这会修正 `helper.ts:816-819` 只按 `chatId` 判定的现状，并与 `http/panel.ts:296-297`、`:343-344` 对齐。需要一条“同 chatId、不同 character”的回归用例。

### 2. Mirror 失败是可观察降级，不是主写入失败

`replace(chat)` 的顺序：

1. 读最新聊天快照；
2. 写 `chat_metadata.variables`（空树删除该键，沿用 `helper.ts:710-711` 与 `mvu.ts:955-956` 的约定）；
3. `saveChat` CAS；
4. 若 AgentTavern 绑定，调用 flat mirror；3 次有界重试（10/20/30ms）。`replace(chat)` 是全量替换；公共 `mirror(ref, tree)` 是 **upsert**，只写传入条目、不删除缺失项。`replaceMvuData` 只传 `stat_data`，因此不会删掉 flat 里的其它 AgentTavern 变量；
5. 镜像最终失败时返回 `{ status: 'degraded', reason }`，不抛错、不回滚第 3 步。

可观察面：helper 的 `variables.replace` / `mvu.replace` 响应携带 `mirror` 字段；pipeline 保持单次提交，暂不接（见偏差）。同时记一条结构化 warn（`chatId`、`reason`、`attempts`）。不把降级状态写进聊天文件，也不新增持久标记。

### 3. Body 与面板 undo 共用 screen

`applyUndo` 与 `undo` 都必须先执行：

1. `latestValidMvuReceipt` / `planMvuUndoRestores`（纯函数）；
2. `screenMvuUndoRestores`（纯函数，**无条件**）；
3. `applyMvuUndoRestores`（纯函数）。

`screenMvuUndoRestores` 拒绝时整次 undo 失败，变量与回执都不动。它还会拒绝 `__proto__` / `prototype` / `constructor` 这类 receipt path 段（write 边界已拒，旧数据也必须在 undo 前拦住）。body 路径的失败码继续走现有的 `body-rollback-*` 分类；面板路径继续走 `MVU_UNDO_UNDO_REJECTED` 与 400。`undo` 的 guard 由 ST/Agent 执行核从聊天与卡片构造；`applyUndo` 的 guard 由 body 调用点构造，gateway 只负责 clone + 执行。

### 4. 空树、`stat_data` 与 `$` 控制键

- 空树删除 `chat_metadata.variables` 键，不写 `{}`。
- `stat_data` / `previous_stat_data` 在 flat mirror 中保持整树单值；不 flat 化（卡内键名可能含 `&`，`VariableStore` 的名字规则会拒绝）。
- `$` 前缀的控制键不镜像；镜像时跳过已有 `$` 条目，也不删除它们（沿用 `helper.ts:784`）。
- `message.variables`、`turn`、`agent` 不在 v1，gateway 不碰。

### 5. 普通写入不自动跑 schema guard

`replace` 只做存储与镜像，不调用 `applyMvuSettlementGuard`。结算 guard 与 `$rules` 仍在 `pipeline.ts` / `mvu.ts` 的结算路径上执行；如果 gateway 也跑一遍，会 double-guard 并改变 clamp 回执的语义。Guard 只在 `applyUndo` / `undo` 里作为撤销契约执行。

### 6. 模板合并留在 pipeline

`generation/pipeline.ts:853-865` 的 template local/global 合并（`mergeTemplateLocalVars`、`scriptGlobals` 写入）仍由 pipeline 负责；gateway 接收合并后的最终树。JSR 的 `stat_data` 协议适配也留在 `mvu-compat.ts` / `helper.ts`，gateway 不解析 `<UpdateVariable>`。

## Strangler 迁移顺序

1. **Characterization first**：新增 `variable-gateway.spec.ts`，先锁 ST / AgentTavern × chat / character / global 的读写矩阵、binding 碰撞、mirror 降级、空树删键、`stat_data` 整树、`$` 键跳过；不改生产代码。
2. **搬纯函数**：把 `variableEntriesForMirror`、`collectVariableEntries` 移到纯模块（暂名 `variable-merge.ts`），原位置保留 re-export；`overlayChatScopedVariables` 暂留 `mvu.ts`（Phase 2 再搬），现有测试不动。
3. **只读 delegation**：gateway 先实现 `read`，接管 `helper.ts:readChatScope` 与 `http/panel.ts` 的 `mvu/status`；写路径仍走旧函数。
4. **写路径 delegation**：实现 `replace`，接管 helper 的 chat / character / global 分支；`pipeline.ts` 的整树回写暂不接 gateway——它和消息/回执必须在同一次 `saveChat` 提交，而当前 gateway 只能单独保存变量；等候选 02 `store.withChat` 落地后再接。`message` 分支留在 helper。
5. **Mirror 升级**：把 `mirrorChatScope` 搬进 gateway，加 3 次有界重试；失败返回 `mirror: degraded`，helper 的 `variables.replace` / `mvu.replace` 响应带上该字段（pipeline 暂不接，见偏差），删除 `helper.ts:713-720` 与 `:750-756` 的 `console.warn` 兜底。
6. **Undo 收口**：实现 `applyUndo` / `undo`，接管面板 `undoMvuStSettlement` / `undoMvuAgentSettlement` 与 body candidate / runtime settlement；`body-rollback-receipts.ts` 也已改为 `applyVariableUndo` 暂存后就地接回。
7. **删旧路径**：删除 helper 里的 mirror / binding 判定、mvu 里的重复 undo 执行核；跑 `pnpm run check`，确认 20 个 gate 全绿。

每一步都保持可回滚：旧函数在新函数接管前不删；新函数先 delegate，再搬逻辑；测试先锁定行为，再改实现。

## 测试存活清单

| 测试 | 处置 |
| --- | --- |
| `packages/plugin/tests/mvu-undo.spec.ts` | 保留，作为面板 undo 的端到端 |
| `packages/plugin/tests/agent-tavern-mvu-settle.spec.ts` | 保留，settlement 仍在 `mvu.ts` |
| `packages/plugin/tests/helper-route.spec.ts` | 保留，断言 wire shape 与 delegation，不再断言 mirror 内部实现 |
| `packages/plugin/tests/tavern-mvu.spec.ts` | 保留，status / retry 面不变 |
| `packages/plugin/tests/mvu-guard.spec.ts` / `agent-tavern-mvu-guard.spec.ts` | 保留，纯 guard 不动 |
| `packages/tavern-store/tests/store.spec.ts` | 保留，store 接口不动 |
| `agent-tavern-body-candidate-receipts.spec.ts` / `agent-tavern-body-mvu-rollback.spec.ts` / body 系列 | 保留；candidate edit 与 runtime settlement 已改走 `gateway.applyUndo`，candidate edit 的返回 chat 是 staged clone；`body-rollback-receipts.ts` 仍直接调 `undoMvuReceipts`（后续） |
| **新增** `packages/plugin/tests/variable-merge.spec.ts` | 13 条：4 条纯函数（JSON 边界/原型污染）+ 9 条真实 store（binding 碰撞、mirror degraded、mirror upsert、missing chat、binding probe 失败、CAS 重试、空树、stat_data、character/global） |
| **Phase 2 新增** `packages/plugin/tests/variable-gateway.spec.ts` | 5 条：staged undo 不改输入、schema drift 拒绝、ST `undo`、AgentTavern `undo`、missing chat 明确报错 |

现有测试是 characterization，不是迁移障碍。唯一调整过的是直接断言 `undoMvuReceipts` 跳过 screen 的用例：C1 落地后已改为断言“schema 变更时拒绝”；Phase 2 又把 candidate edit 的返回 chat 改为 staged clone，相关用例改为断言返回值并保留输入不变。

## 开工前检查表

| 项 | 答案 |
| --- | --- |
| 1 所有者 | 新增 `packages/plugin/src/variable-gateway.ts`（唯一策略入口）；`TavernStore` / `VariableStore` 仍是存储 adapter。 |
| 2 唯一事实来源 | 按架构分工不变：ST 用 `chat_metadata.variables`，AgentTavern 用 chat 作用域 `VariableStore`，character/global 用 `state.json`。Gateway 只编码“哪个源赢、何时镜像”，不另建存储。 |
| 3 持久态及理由 | 不新增持久态。镜像仍写 `VariableStore`，聊天仍写 JSONL，character/global 仍写 `state.json`。 |
| 4 临时态 | 合并后的 `VariableTree`、`StagedUndo`、`VariableWriteReceipt` 只在调用内存在；不缓存 binding、不缓存变量树。 |
| 5 外部依赖 | `TavernStore`、`VariableStore`、`state.sessionBindings`、`screenMvuUndoRestores`；无网络、无新宿主 seam。 |
| 6 注册入口 | 在 `runtime.ts` 以 shared store handles 创建 gateway，注入 helper / mvu / panel / pipeline；不新增 HTTP 路由。 |
| 7 删除路径 | 删除 `variable-gateway.ts` 与各调用点的 delegation，恢复旧函数；三份存储、聊天文件、回执账本均不受影响；无数据迁移、无标记文件。 |
| 8 兼容对象 | 旧聊天 JSONL（无变量键 / 空树）、ST 与 AgentTavern 两种 binding、JSR wire shape、`$schema` / `$rules`、`stat_data` 整树、`message.variables`、`turn` / `agent` 作用域。 |

## 删除路径（第 7 项）

**怎么关**：删除 `variable-gateway.ts`，把 helper / mvu / panel / pipeline 的调用点恢复为现有函数；没有常驻定时器、没有事件订阅、没有新文件格式。Gateway 本身无持久态，关闭后不需要清理任何数据。

**关掉后残留有害吗**：没有。镜像与聊天写入仍是原来的两条路径；gateway 只是策略收口，不改变存储位置。唯一的行为差异是 binding 判定从“只按 chatId”变成“character + chatId”，这是修正而不是兼容负担。

**回滚**：按 Strangler 的反向顺序回滚（先恢复 undo，再恢复 replace，再恢复 read）；每一步都有旧函数可回退，不需要数据迁移。

## 否决项

- **把三份存储合并成一份**：违反 `2026-10-11-mvu-receipt-undo.md:20` 与 `2026-10-20-frontend-helper-compat.md:16` 的按架构唯一事实来源；会改变 ST 与 AgentTavern 的可见语义。
- **v1 覆盖 `message` / `turn` / `agent`**：这些作用域没有观察到的镜像/overlay 分叉，扩面只会增加迁移风险；留到有真实需求时单独决策。
- **B2 mirror 失败即整体失败**：会把兼容镜像变成聊天主写入的硬依赖；`VariableStore` 不可用时，ST 兼容写也会失败。
- **B3 保持 `console.warn`**：用户与调用方都看不到降级；同一个“写变量”在不同入口有不同的可观察性。
- **C2 / C3 保持 body 例外**：同一个撤销动作在面板与 body 上 guard 语义不同；schema 漂移时终态取决于入口。
- **D2 一次性重写**：6 个入口、4 套入口级测试、body 事务链；风险远高于 Strangler。
- **把 `applyMvuSettlementGuard` 塞进每次 `replace`**：会与 `pipeline.ts:873-879` 的结算 guard 双跑，改变 clamp 回执与 `$rules` 的语义。
- **为过 800 行预算而拆 gateway**：`mvu.ts` 是 allowlist 的 1,265 行；抽 gateway 是为了 locality，不是为了把行数压到 800。Gateway 自身应保持小而深，不为了预算拆成多个浅模块。

## 风险与已知边界

- **跨 bundle**：`index.mjs` / `agent.mjs` / `novel.mjs` 等是独立 esbuild 产物；gateway 必须无状态，只依赖 `sharedTavernStore` / `sharedVariableStore` 句柄。不要在 module 级缓存 binding 或变量树。
- **无跨 store 2PC**：AgentTavern undo 同时写 flat `VariableStore` 与 chat 回执；`decisions/2026-10-28-agent-tavern-body-write-rollback.md` 已记录“无跨 store 2PC”。Gateway 保持现有失败语义并如实上报，不承诺原子性。
- **`helper.ts` 的 `stat_data` 规则**：`helper.ts:807-809` 明确 `stat_data` / `previous_stat_data` 保持整树单值；搬移时不能 flat 化，否则含 `&` 的卡内键名会被 `VariableStore` 拒绝。
- **`mvu.ts` 的纯函数导出**：Strangler 期间保留 `planMvuUndoRestores` / `screenMvuUndoRestores` / `applyMvuUndoRestores` 的导出给现有测试；迁移完成后可以收成 gateway 内部实现，但不要在同一批改动里同时删除测试与实现。
- **binding 碰撞修复是行为变化**：修复后，同 chatId、不同 character 的 helper 读写会从“可能读错绑定”变成“按 character 匹配”。已由 `variable-merge.spec.ts` 的 mismatched binding 用例覆盖；这是修正，不是兼容性破坏。
- **性能**：`read(chat)` 需要一次聊天快照 + 一次 state 读取；现有 `readChatScope` 已经做同样的读取。Gateway 在一次调用内复用快照，不引入跨调用缓存。
- **观测面**：`mirror: degraded` 先在 helper 的 `variables.replace` / `mvu.replace` 响应中返回；pipeline 暂不接（见偏差）。不新增持久化状态。若后续需要面板常驻显示，再单独决策是否加进程内环形缓冲。

## 验证

全量验证（2026-11-02，Round 10 后，commit `b27f4dd`；宿主并行会 OOM，故用等价串行 `vitest run --no-file-parallelism`）：

```text
Test Files  200 passed (200)
Tests       3297 passed | 2 skipped (3299)
20 gates    PASS
built       v0.7.5 (b27f4dd)
```

- Phase 1 targeted（最终）：`helper-route` 39 + `tavern-mvu` 32 + `variable-merge` 13 = 84 用例通过。
- C1 targeted（最终）：`mvu-undo` 17 + `tavern-mvu` 32 + body-candidate 29 + body-mvu-rollback 8 = 86 用例通过。
- Phase 2 targeted（2026-11-02）：`variable-gateway` 5 + `mvu-undo` 17 + body-candidate 29 + body-mvu-rollback 8 + `variable-merge` 13 = 72 用例通过。
- Phase 2 body 集成 targeted（2026-11-02）：`agent-tavern-body-runtime` 87 + `agent-tavern-body-projector` 37 + body-rollback 48 + body-rollback-integration 5 = 177 用例通过。
- Round 10 targeted（2026-11-02）：`agent-tavern-body-rollback` 48 + `agent-tavern-body-mvu-rollback` 8 + `agent-tavern-body-rollback-integration` 5 + `agent-tavern-body-candidate-receipts` 29 + `agent-tavern-body-runtime` 87 + `variable-gateway` 5 = 182 用例通过；同一条 tsc 命令无输出。
- Phase 2 类型检查：`node node_modules/typescript/bin/tsc -p packages/plugin/tsconfig.json --noEmit --composite false` 通过（无输出）。
- 新增 `variable-merge.spec.ts` 13 条：4 条纯函数（JSON 边界/原型污染）+ 9 条真实 store（binding 碰撞、mirror degraded、mirror upsert、missing chat、binding probe 失败、CAS 重试、空树、`stat_data` 整树、character/global）。
- 新增 `variable-gateway.spec.ts` 5 条：`applyVariableUndo` 返回新 chat 且输入不变、schema 漂移拒绝且输入不变、ST `undo` 恢复 `chat_metadata.variables`、AgentTavern `undo` 恢复 flat chat-scope `VariableStore`、missing chat 明确报错。
- 新增 C1 回归：`agent-tavern-body-mvu-rollback.spec.ts` 的 schema 漂移用例，undo 拒绝且变量/回执不动；`mvu-undo.spec.ts` 新增 forbidden receipt path 拒绝用例。
- 测试稳定性：`state-slices.spec.ts` 的 readonly rename spy 断言收窄到当前 store 目录，避免并行测试的写入污染 `attempts`；全量 199 文件连续通过。
- redo screen 决策（2026-11-03）：`mvu-undo` 17 + `tavern-mvu` 32 + `agent-tavern-body-mvu-rollback` 8 + `variable-gateway` 5 + `agent-tavern-body-rollback` 48 + `agent-tavern-body-rollback-integration` 5 = 115 用例通过；代码仅补注释，无行为变化。
- 已决策（2026-11-03）：`redoMvuReceipts` 不做 `$schema` screen；理由与调用面见「后续」。

## 偏差（据实记录）

- **pipeline 暂不接 `gateway.replace`**：`generation/pipeline.ts` 的消息、回执与变量必须在同一次 `saveChat` 提交；当前 gateway 只能单独保存变量，接进去会把一次提交拆成两次并扩大变量覆盖窗口。因此 pipeline 保持原单次提交，等候选 02 `store.withChat` 落地后再接。首版实现曾接入，集成复核发现双提交后已撤回。
- **Phase 2 已实现 `applyUndo` / `undo`**：面板与 candidate/runtime body 已收口；`body-rollback-receipts.ts` 也已改为 `applyVariableUndo` 暂存后把新树就地接回原 chat，因此输入对象只在 screen 通过后更新，settle receipt 标记仍落在同一棵树上。`applyVariableUndo` 不接收 `at`，body candidate 的 `undoneAt` 改为当前时刻（旧实现使用 body event 时间）；回执顺序与恢复结果不变。
- **`replaceCharacter` / `replaceGlobal` 没有独立 revision**：receipt 只带 `mirror`，不带 `revision`；state 写入没有独立 revision，调用方不得把它当 CAS 信号。
- **`replaceMvuData` 已走 `withChat`**：消息 + 变量在同一次事务内提交；mirror 在事务后按 `stat_data` upsert。候选 02 已实施，见 `decisions/2026-11-02-chat-write-transaction.md`。
- **`replace(chat)` 的 full mirror 先删后 patch**：patch 永久失败时可能留下部分删除并只返回 `degraded`；后续可加补偿或改成单次原子 patch。
- **read-after-degraded**：mirror 降级后，同一 chat 的 `read` 仍可能被旧 flat 值 overlay（AgentTavern flat 优先语义）；下一次成功 mirror 收敛。后续可加 read-repair。
- **helper / panel 的额外 snapshot 读取**：helper 先取 chat 再调 `gateway.read`，gateway 内部再取一次；面板 undo 同理：路由先取 snapshot 做 404 / revision 预检，`gateway.undo` 再取一次作为写基准。预检与写基准之间若有并发写，以写基准的 CAS 为准，预检只用于快速失败。Phase 2 未让 gateway 接受已取 snapshot。
- **C1 的 body 接线集成测试**：candidate edit、runtime settlement 与 `applyReceiptRollback` 均已接 gateway staged undo；完整 rollback 路径由 `agent-tavern-body-rollback.spec.ts` 覆盖，schema 漂移的纯函数用例由 `variable-gateway.spec.ts` 与 `agent-tavern-body-mvu-rollback.spec.ts` 覆盖。`redoMvuReceipts` 保持不 screen（2026-11-03 决策）。
- **测试文件名**：Phase 1 的矩阵测试落在 `variable-merge.spec.ts`（同时覆盖 gateway 的 store 集成）；Phase 2 的接口级 undo 矩阵补在 `variable-gateway.spec.ts`。

## 后续

- Phase 2 已完成面板、candidate/runtime body 与 `body-rollback-receipts.ts` 的收口；所有 undo 路径都通过 gateway 的 staged restore。
- `redoMvuReceipts` 不做 `$schema` screen（2026-11-03 决策，选项 A）：redo 只回放结算时已被守卫接受的 after 值；唯一调用面是 `applyReceiptRollback` 的失败补偿，undo 刚在同一 schema 下成功，事后再次 screen 只会增加抛错点并可能掩盖原始错误。`$schema` 与 forbidden segment 在结算时已被守卫拒绝，redo 信任这份已接受的回执。若将来出现用户可点的独立 redo 命令，另立决策。
- 候选 02（`store.withChat`）已落地到 helper 的五条 chat 写路径（message 作用域变量、`mvu.replace`、`chat.world.set`、`messages.rotate`、messages 增删改）；`chat-saved` 统一在事务成功后发射。pipeline 仍保持单次 `saveChat`，等它自己的集成，见 `decisions/2026-11-02-chat-write-transaction.md`。
- 如果 `message` / `turn` / `agent` 出现同类分叉，再单独扩 `VariableRef`，不在本决策里预留。
- 文档已同步：`CONTEXT.md` 的「Variable Gateway」词条与 `docs/README.md` 的「记忆与变量」条目更新为 Phase 2 状态；根 `README.md` 的测试基线同步为 200 文件 / 3297 passed / 2 skipped。
