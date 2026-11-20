# 采用 DSH 0.2.2-rc.5 的批量 `Session.append(inputs[])`

> 日期：2026-11-20。状态：已实施。相关：`decisions/2026-11-20-dsh-022-rc5-verification-runtime.md`（宿主升级）、`decisions/2026-10-11-confirmable-session-writes.md`（读回确认协议）、`decisions/2026-09-09-dsh-bind-library.md`（bind 单源兼容层）。

## 用户需求

「支持新增的批量 `append(inputs[])`。」

## Problem

DSH `0.2.2-rc.5` 给 `Session.append` 增加批量重载：首参不是字符串时，宿主先把整批 `[type, data, opts?]` 快照与 surface 折叠全部校验完，再一次性提交；任一候选或同步派发校验失败时，日志在提交前保持原状。插件的 bind 层仍只有逐条写入，历史导入这种「整段计划要么全落、要么不落」的写路径在中途失败时会留下可观测前缀，只能靠导入协议事后兜底关闭半个 turn。

## Decision

### 1. bind 单源：能力探测 + 双模式封装

新增 `packages/bind/src/session-append.ts`：

- `supportsSessionBatchAppend(session)` 探测 `session.surface.prepareBatch`。批量 append 的 surface 折叠依赖该方法，rc.5 的公开 `Session.surface` 因此是可靠的能力信号；不按宿主版本号分支。
- `appendSessionEvents(session, inputs)` 返回 `{ mode, events }`：
  - `batch`：一次 `append(inputs)`，保留 `surfaceOp`；失败抛 `SessionAppendError`（`committed = 0`，`cause` 是宿主异常），不降级重试。
  - 批量调用保留 `session` 作为 receiver（不能提取 `append` 方法引用，宿主实现依赖 `this`）。
  - `sequential`：老宿主按输入顺序逐条 `append(type, data, opts)`；首个失败抛 `SessionAppendError`，`committed` 是已落日志的前缀长度。
  - 空输入不调用 `append`，两种宿主都返回空结果。
- `SessionAppendError` 与 `committedSessionAppends(error)` 把部分提交计数暴露给恢复逻辑：调用方按已提交条数决定补关 turn/step，而不是把所有失败都当成“全没写”。
- 探测不到 `prepareBatch` 时明确走逐条语义，绝不把数组盲传给老宿主。

### 2. 迁移历史导入

`applyAgentTavernHistoryImport()` 的整段计划与后缀重试改走 `appendSessionEvents()`：

- rc.5 上首次导入只发一次数组 append；成功后读回对齐照旧。
- 原生批量失败不留下前缀，`landedPlanAppends` 读到 0；日志尾部等于 baseLength，后缀重试等价于整段重试，不产生重复轮号。
- 老宿主逐条写入次数与顺序不变，现有 partial / retry / swallow 测试继续覆盖。

### 3. 迁移 body-runtime 与 trace 的括号写入

- `appendHideInBridgeTurn()`：`turn/start + step/start`、`step/end + turn/end` 各自成批；失败时用 `committedSessionAppends()` 还原 `turnOpen` / `stepOpen`，再交给 `closeBracketBestEffort()`。
- `restoreBodyAfterFailure()` 的重建 turn：同一套开/闭括号批量化与部分提交恢复。
- `beginTavernSessionTurn()`：`turn/start + user/message` 成批；批量失败不补 `turn/end`，老宿主已落 `turn/start` 时仍补关半开的 turn。
- `finishTavernSessionTrace()`：`step/end + turn/end` 成批；任一路径失败都停止 trace 且不推进 live loop 轮次基线。
- 仍保持单条写入的是 best-effort 或逐条确认路径（`closeBracketBestEffort`、`closeImportBracket`、`occupyHostSession` 的读回确认、`startTavernSessionStep` / `recordTavernSessionAssistant`），它们的失败语义本来就是单事件粒度。

## 验证

- `packages/bind/tests/session-append.spec.ts`：批量一次提交、老宿主逐条顺序、空输入、批量/逐条失败的部分提交计数；另有 skipIf 环境下对真实 rc.5 `Session` 的批量提交回归（`surface.prepareBatch` 探测命中、一次数组 append 落 5 条事件）。
- `packages/plugin/tests/session-activate.spec.ts`：整份导入计划只发一次数组 append、`surfaceOp` 保留、轮次基线照常推进；老宿主用例继续通过。
- `packages/plugin/tests/session-trace.spec.ts`：turn 开/闭批量、老宿主顺序、批量失败零提交、老宿主失败后补关 turn、失败不推进基线。
- `packages/plugin/tests/agent-tavern-body-runtime.spec.ts`：bridge turn 两次原生批量、老宿主 `step/start` 失败后补关半开 turn、原生开批失败零残留。
- 定向测试：`npx vitest run packages/bind/tests/session-append.spec.ts packages/plugin/tests/session-activate.spec.ts packages/plugin/tests/session-trace.spec.ts packages/plugin/tests/agent-tavern-body-runtime.spec.ts` → 112 passed。
- 全量 `pnpm run check` 在 DSH `0.2.2-rc.5` 上通过：`Test Files 220 passed (220)`，`Tests 3560 passed | 2 skipped (3562)`，21 gates PASS。

## 边界

- 不改宿主版本承诺：`0.2.2-rc.5` 为当前验证面，旧宿主按逐条语义继续兼容。
- 不引入额外依赖或运行时探测缓存；探测每次按对象形状判定。