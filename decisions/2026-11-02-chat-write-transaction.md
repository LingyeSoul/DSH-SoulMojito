# 决策：聊天写入事务缝（`TavernStore.withChat`）

> 日期：2026-11-02。状态：已实施（helper 的五条 chat 写路径；pipeline 仍为单次 `saveChat`，最终变量树经 gateway staging）。范围：架构审查候选 02。相关：`packages/tavern-store/src/store.ts`（`withChat` / `ChatWriteOptions` / `ChatWriteResult`）、`packages/plugin/src/helper.ts`、`packages/tavern-store/tests/chat-with.spec.ts`、`packages/plugin/tests/helper-route.spec.ts`、`decisions/2026-11-02-variable-gateway.md`。

## 问题

helper 的 chat 写入有五条各自为战的重试车道：message 作用域变量（`helper.ts:684`）、`mvu.replace`（`:731`）、`chat.world.set`（`:1013`）、`messages.rotate`（`:1198`）、messages 增删改（`:1548`）。每条都重复同一套编排：

1. `requireChat` 读快照；
2. 直接改 `snapshot.chat` 的整棵树；
3. `saveChat` 带读到的 revision 做 CAS；
4. `persistChat` 落盘后发 `chat-saved`，且这一步在 `retryChatWrite` 闭包内。

迁移前这带来三个问题：重试策略有五份副本；调用方必须在重试闭包里重新读、重新算；store 没有“读—改—CAS 重试”的单一契约，gateway 与 helper 各自复制 CAS 循环。数据安全仍由 `saveChat` 的 CAS 兜底，本决策收口的是编排，不是存储格式。

## 接口

```ts
export interface ChatWriteOptions {
  readonly attempts: number
  readonly delayMs: (attempt: number) => number
}

export interface ChatWriteResult {
  readonly chat: ChatLogIR
  readonly revision: string
}

withChat(
  characterName: string,
  chatId: string,
  mutate: (chat: ChatLogIR) => void,
  options: ChatWriteOptions,
): Promise<ChatWriteResult>
```

`mutate` 是同步回调；异步输入（`state`、`statData`）必须在进入回调前算好。策略由调用方显式传入，store 没有隐藏默认值。`helper.ts:876` 的 `CHAT_WRITE_POLICY` 固定为 3 次尝试；两次重试间隔 10ms、20ms（`withChat` 不在最后一次失败后等待）。旧 `retryChatWrite` 在第三次失败后还会再等 30ms 才抛错，迁移后最后一次冲突立即抛出；重试次数与前两档退避不变。

## 行为

1. `attempts` 必须是正安全整数、`delayMs` 必须返回有限非负数；非法策略在读取聊天前直接报错。
2. 每次尝试：`getChatSnapshot` → `structuredClone` → `mutate(clone)` → `saveChat(..., snapshot.revision)`。
3. 只有 `ChatRevisionConflictError` 重试；mutation 抛错和其他落盘错误第一次就向上抛，不重试。
4. 全部尝试失败时不改 store 缓存的快照、不改聊天文件；store 自身不发事件。
5. 调用方在 `withChat` 返回后发一次 `chat-saved`，携带 `saved.revision` 与 `saved.chat.messages.length`。
6. 落盘后的异步副作用（例如 `mvu.replace` 的 mirror）放在事务外，使用 `saved` 结果，不塞进同步回调。

## 迁移清单

| 路径 | 入口 | 迁移后 |
| --- | --- | --- |
| message 作用域变量 | `helper.ts:684` | 在 `withChat` 回调内解析 message_id 并写 `message.variables`；事务成功后发事件（`:716`） |
| `mvu.replace` | `helper.ts:731` | `statData` 在事务前校验；message_id 在回调内按最新消息数解析；事务后发事件、再 mirror（`:740`） |
| `chat.world.set` | `helper.ts:1013` | 在回调内改 `chat_metadata.world`；事务后发事件（`:1023`） |
| `messages.rotate` | `helper.ts:1198` | 在回调内按最新消息数校验区间并重排；返回值取 `saved.chat`（`:1205`） |
| messages set/create/delete | `helper.ts:1548` | `state.activePersona` 事务前读取；回调内改消息；返回值取 `saved.chat`（`:1557`） |

`retryChatWrite` 已删除。`serializeSessionWrite` 保留：它先按 chat 键串行化 helper 写入，再把 CAS 重试交给 `withChat`。`persistChat` 保留给未迁移的 `runHelperSlash` 与 `renderFrontendTemplate` 路径。

## 行为变化

- **`chat-saved` 时序**：对外可观察时序不变——成功落盘后、HTTP 响应前发一次。实现位置从 retry 闭包内的 `persistChat` 移到 `withChat` 返回之后；CAS 冲突重试期间不发事件，最终成功后恰好一次，失败写入不发。
- **最后一次冲突不再等待**：旧 `retryChatWrite` 在第三次冲突后仍会 sleep 30ms 再抛错；`withChat` 只在还有下一次尝试时才等待。重试次数（3）与冲突成功后的前两档退避（10ms、20ms）不变。
- **错误文案**：迁移路径上不存在的 chat 现在由 `withChat` 报 `chat '<id>' of character '<name>' not found; withChat requires a persisted chat snapshot`，不再走 `requireChat` 的 `chat '<id>' not found`。
- **校验顺序**：`mvu.replace` 先校验 `statData` 再读 chat；messages 增删改先读 `state` 再读 chat。只是失败顺序变化，成功路径的返回形状不变。
- **回调只拿 clone**：helper 不再直接修改 `getChatSnapshot` 的返回值；每次尝试都从最新快照重新 clone，失败尝试的改动不会成为下一次尝试的输入。

## 删除路径

把 helper 的五条路径恢复为 `retryChatWrite` + `persistChat`，再删 `CHAT_WRITE_POLICY`。`store.withChat` 无状态、无定时器、无事件订阅、无持久标记，可以直接删除；聊天 JSONL 与缓存格式不变，不需要数据迁移。回滚后残留的数据为零。

## 测试

- `packages/tavern-store/tests/chat-with.spec.ts` 8 条：clone 后落盘、CAS 冲突重读重放、mutation 错误不重试、非冲突落盘错误不重试、尝试耗尽抛最后一个冲突、失败不动缓存与文件、missing chat 明确报错、非法策略在读取前拒绝。
- `packages/plugin/tests/helper-route.spec.ts` 新增 1 条：helper 写入成功只发一次 `chat-saved` 且 revision/floorCount 与落盘一致；随后一次越界写入返回 500 且不再发事件（`:342`）。
- 目标回归（2026-11-02）：`pnpm vitest run packages/plugin/tests/helper-route.spec.ts packages/plugin/tests/helper-client.spec.ts packages/tavern-store/tests/chat-with.spec.ts packages/plugin/tests/variable-merge.spec.ts` → 4 文件 / 84 用例通过。
- 类型检查：`node node_modules/typescript/bin/tsc -p packages/plugin/tsconfig.json --noEmit --composite false` 与 `... packages/tavern-store ...` 均无输出。
- 全量 `pnpm run check`（2026-11-02，Round 3）：200 files / 3297 passed / 2 skipped / 20 gates PASS / build v0.7.5 (0a995e4)。

## 已知边界

- `serializeSessionWrite` 与 `withChat` 是两层：前者管同进程 helper 写入顺序，后者管 CAS 收敛；都不承诺跨进程事务。
- `pipeline`、body 写入与 slash/template 路径仍走原有 `saveChat`/`persistChat`；本决策只迁移 helper 的五条 chat 写入。pipeline 的最终变量树经 gateway `stageChatVariables` 归一化，但仍由 pipeline 自己单次 `saveChat` 提交，不进入 `withChat` 重试。
- 事件在事务外发射，监听器异常由 mod 事件总线逐个吞掉，不会回滚已成功的落盘。
