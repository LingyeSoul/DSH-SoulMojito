# 审计 A · 主服务 ctx 服务面（已完成 2026-10-05）

宿主基准：`.npm-cache/dsh-runtime/node_modules/@deepseek-ai/`（0.2.0-rc.2 / cordis 4.0.4）
总判定：9 个 inject 服务、5 类事件订阅、llm 流式与目录、agent 对象面、HTTP/命令/压缩/subagents/pluginManager/DSH_HOME 全部双侧证据吻合 ✅。雷集中在"写得出、读不回"的会话日志层。

## P0 ❌（与 C1 同一问题，三路交叉印证）

1. **`assistant/chunk` 追加进 v4 会话 → 重载即毒化** — `index.ts:2559`（recordTavernSessionChunk）、调用点 `index.ts:2087`（每个 llm chunk 一次）。
   - 宿主：append 无类型白名单（`dsh-session/lib/index.js:1441-1476`）、v4 encode 不拒（`v3-to-v4:1092-1098`）、jsonl 逐行写（`persistence-jsonl:955,984`）→ 全程静默；读回 `restoreReleasedV4Artifact` 遇未知非 ignorable 类型整文件抛 `SessionFormatUnsupportedMigrationError`。
   - 修复：移除 chunk 落盘或改走进程内 `agent/assistant-stream` 事件（`dsh-agent/lib/types/runtime-types.d.ts:366`）。

## P1 ⚠️（与 B 同一问题 + 新影响路径）

2. **`assistant/message` 缺必填 `stream`** — `index.ts:2570-2579`。
   - 双重影响：① B 路发现的 seed 校验毒化（`assertAssistantSettlementShape`）；② A 路发现的 **dsh-session-stats 投影无守卫迭代** `event.data.stream`（`dsh-session-stats/lib/types/projection.js:104` → `dsh-llm/lib/index.js:1381` `for (const record of stream)`）→ TypeError，原生 token/TTFT 统计持续失败。
   - 修复：补 `stream: []`（或从 chunk 序列组装真实记录）。

## 其余 ⚠️

3. **测试 mock 零格式层** — `tests/tavern-command.spec.ts:32-45` mock Session 接受一切类型；**L276 甚至断言 assistant/chunk 被追加**——P0 的盲区根因。修复方向：测试挂真实格式目录做 encode→restore 往返断言（与 C3 的 gate 方案合并）。
4. **`watchPluginManager` 把 `ctx.inject` 返回的 Fiber 当 disposer** — `update/apply.ts:158-166`；cordis `registry.d.ts:185` `inject(deps,cb)` 返回 `Fiber & PromiseLike`，非函数 → `typeof dispose==='function'` 恒 false → noop 回落，监听 fiber 永不清理（低危泄漏）。修复：`(fiber as any)?.dispose?.()` 挂进 effect。
5. **`snapshotEvents()` 已 @deprecated** — `bind/host-session.ts:26`（`dsh-session/lib/types/index.d.ts:186-193` "new calls are prohibited"）。0.2.0-rc.2 可用，跟踪宿主迁移公告。
6. **两处注释/类型撒谎**：`index.ts:497` 对 ctx.get 字符串重载的否定描述失实（`cordis reflect.d.ts:14-16` 支持）；`index.ts:2077` system 角色请求消息 source `{kind:'plugin'}`（TS 类型应为 `system-prompt`，运行时无校验）。修注释即可。

## 已验证 ✅（抽样）

- llm.stream options/chunk 分支/FinishReason、listProviders 同步、listModels/resolveModelInfo、currentSelection 同步。
- webServer prefix 路由、systemPrompt.section、compactNow(agent,signal)、sessionProjections.stateOf。
- 事件订阅 session/event、agent/created|disposed|status、agent/pre-step waterfall+prepend。
- commands.register、agents.get、recompose/compositionInventory/mount、withoutInitiator、inject/followup。
- dsh-home env/默认两档一致（宿主 configured 显式档会分叉——与 B 路发现一致，边缘可接受）。
