# 决策：失效会话绑定的可回收（双信号否定 + 默认关闭）

> 日期：2026-11-02。状态：已实施（默认关闭）。相关：`packages/tavern-store/src/store.ts`（`pruneSessionBindings`）、`packages/plugin/src/session/reclaim.ts`、`packages/plugin/src/index.ts`（唯一注册点）、`packages/tavern-store/tests/session-binding-prune.spec.ts`、`packages/plugin/tests/session-binding-reclaim.spec.ts`、`decisions/2026-11-01-tavern-state-asset-split.md`（存储契约）、`decisions/2026-11-01-tavern-read-caches.md`（读路径只读）。

## 问题

- `state.json` 里 `sessionBindings` 是这份文件里**唯一随使用单调增长**的部分：其余键是开关、当前卡/书/预设和固定表，条数不随会话数增长。示例数据根上的观测：这张表占文件一半以上，每条约几百字节（键数、字节数随卡库/预设/宿主版本变化，不可复现；与机器无关的结论只有一条——这张表随被删会话单调增长）。
- 绑定的写入入口唯一（`packages/plugin/src/session/binding.ts:12` 的 `bindSession`），读取面遍布生成、投影、锚定、压缩与面板；**没有任何服务端回收路径**。会话被用户「删掉」（宿主语义是 archive，见判据表）之后，这条绑定留在表里直到有人手动清。
- 仓库里已有一条清理路径，但它跑在客户端：面板加载后把宿主会话列表之外的绑定整批 `POST bindings/prune`（`packages/plugin/client-src/94-panels-tail.js:392-400`，服务端在 `packages/plugin/src/http/router.ts:813`）。它有两个约束：只覆盖「用户打开过面板」的场景；判据只有「UI 会话列表」一个信号。
- 因此本决策只回答一件事：**给服务端一个可证明、默认关闭、宁可少删的回收路径**，不改变客户端那条既有路径的行为。

## 判据

一条绑定只有同时满足以下两条才算失效：

| 信号 | 来源（真实契约 / 真实文件） | 可靠性 | 结论 |
| --- | --- | --- | --- |
| 宿主不认识：没有活 agent | `ctx.agents.list()`（`packages/plugin/src/host-contract.ts:115`；宿主 `AgentRegistry.list()`，`dsh-agent/lib/types/index.d.ts:357`，语义「all live agents」） | 只列**活** agent；启动期为空是正常的，所以它单独不构成判据 | 取 **AND** |
| 宿主不认识：没有活会话 | `ctx.sessions.list()`（`host-contract.ts:185`；宿主 `SessionStore.list()`，`dsh-session/lib/types/index.d.ts:452`，语义「all live sessions」） | 同上；补齐「有会话没 agent」的窗口 | 取 **AND** |
| 磁盘上也没有工件：全量库存 | `ctx.get('sessionPersistence').list()`（`host-contract.ts:257` 的 `get`；宿主 `SessionPersistence.list()`，`dsh-session-persistence/lib/types/index.d.ts:157`） | 后端自己枚举配置好的 sessions root（JSONL 默认 `dshHomePath('sessions')`，`dsh-base/cordis.patch.yml:130-133`），**不是**插件拼路径，所以自定义 root / 多项目目录 / 编码转义都天然正确 | 取 **AND** |
| 磁盘上也没有工件：单条复核 | `ctx.get('sessionPersistence').stat(id)`（同上 `:151`） | 逐候选复核，收窄「`list()` 与写盘之间另一个进程刚落盘」的窗口；JSONL 后端按 id 在全部项目目录里找当前代际文件 | 取 **AND** |

**被排除的信号**：

| 信号 | 为什么不用 |
| --- | --- |
| 绑定/会话的时间戳、`state.json` 的 mtime、`sessionBindings` 的写入顺序 | 时间不能证明「不存在」。用户可能几个月后重开一个会话，凭时间删就是错删。 |
| `state.json` 里 `chats` 元数据的时间 | 同上，且与宿主会话无关。 |
| 面板/UI 的会话列表（客户端当前唯一判据） | 它依赖「用户打开面板 + UI 已加载完毕」，而且只有一个信号；服务端复刻它等于把错删风险搬进后台。 |
| `ctx.get('workspaceRegistry').archivedSessionIds`（宿主 archive 集，`dsh-workspace/lib/types/index.d.ts:195`） | **archive 可逆**（`unarchiveSession`，`:224`），归档会话的工件与位置都保留（`delete` 的契约明写「retaining its directory and every session log」，`:173`）。用它可以删得更狠，但误删面也更大——本决策明确不做。 |
| 直接扫 `$DSH_HOME/sessions/` 目录 | 插件不该猜宿主配置。sessions root 是 profile 可覆写的（`dsh-base/cordis.patch.yml:133`），自建路径会在自定义部署上把活会话判成死。 |

**判据不完整时的规矩（全部 fail-closed）**：`ctx.agents.list` / `ctx.sessions.list` / `sessionPersistence.list` / `sessionPersistence.stat` 任缺一个、条目读不出 id、或调用抛错 → 整轮跳过，**一条不删**，只记结构化 `reason`。理由：删用户数据时「证明不了」只能等于「不动」，不能等于「大概没有」。

## 开关形状

profile 行 config 的一个字段，一个字段区分干跑与真删：

```yaml
- id: dsh-soulmojito
  config:
    pruneStaleBindings: report   # 或 prune；缺省 = 关闭
```

| 值 | 行为 | 写盘 |
| --- | --- | --- |
| 缺省 / `null` | `off`：注册即刻返回，**连 store 都不打开** | 零 |
| `report` | 跑完整判据，只记一条结构化日志（`scanned` / `keptLive` / `keptStored` / `stale` / `removed: 0` / `retained`） | 零 |
| `prune` | 同一份判据算完后，一次 `updateState` 删除；汇总日志额外带 `removedIdSample`（前 20 条被删 id，总数看 `removed`） | 至多 1 次 |
| 其它任意值（含 `true`） | 按 `off` 处理，并留一条 `reason: 'unsupported-config'` 的 warn（写错开关不能静默） | 零 |

推荐运维顺序：先 `report` 看日志里的 `stale`，确认数量与预期一致，再改 `prune` 跑一次。因为默认关闭且判据极严，`report` 在前不改变任何盘面。

## 三种盘面下的行为

| 盘面 | 结果 |
| --- | --- |
| 没有 `state.json`，或 `sessionBindings` 为空 | `scanned: 0`，`report` 只记日志，`prune` 不写盘（`pruneSessionBindings` 看到零候选直接返回，见下）。 |
| 表里有绑定，但每条都能被活会话面或磁盘库存认领（宿主无物理删除能力 + archive 保留目录，常规使用下就是这种盘面，见「已知边界」） | `stale: 0` / `removed: 0`，**零写入**（`report` 与 `prune` 在该盘面完全等价，测试分别钉住零写入：文件内容与 mtime 都不变）。 |
| 表里有候选 | `report`：`stale: N`、`removed: 0`，文件内容不变。`prune`：一次 `updateState` 删掉这 N 条，其余键的值不变。 |

删除动作本身在 store 侧的形状（`pruneSessionBindings(remove)`）：

1. 读一次当前表，取 `observed ∩ remove` —— `remove` 是**调用方的判定结果**，store 不重新推导；
2. 交集为空 → 直接返回，**不进写路径**；
3. 非空 → **一次** `updateState` 过滤掉这批 id，返回实际删除的 id 与被保留的条数。

判定落在调用侧（`reclaim.ts` 算出失效集），删除面落在 store 侧（只删自己快照里也在 `remove` 里的 id）。这个分工是**快照作用域**的兑现方式：读到判定快照之后、写盘之前别处新写入的**新 id**（例如 `agent/created` 的 fork 收养调用 `bindSession`）既不在 `remove` 里，也不会被带走（`session-binding-prune.spec.ts` 与 `session-binding-reclaim.spec.ts` 各有一条专门用例）。同一边界：**同一个已判失效的 id 若在窗口内被重新绑定，仍会被这次回收删掉**——判定是 id 级的，不带内容版本；这个窗口极窄且要求该 id 恰好被判失效，本决策接受该边界。`state.json` 仍是唯一提交点，补丁不带切片键，两张切片不会被重写。

## 删除路径（第 7 项检查表）

**怎么关**：把 `pruneStaleBindings` 从 profile 行里删掉（写成其它值时也会退回 `off` 并留一条 warn，但请直接删）。回收只在 `apply()` 里跑一次，关掉后下一次启动连 `state.json` 都不读。没有常驻定时器、没有事件订阅、没有 `getState()` 副作用——读路径与本次改动前完全一致。

**关掉后残留的绑定有害吗**：没有功能危害。绑定是「这个 DSH 会话属于哪个角色/聊天/架构」的映射；宿主侧会话已不存在时它不会被任何读路径命中（生成、投影、锚定、压缩都先拿 `sessionId` 查表）。它的代价只有文件体积：一条绑定是几百字节量级，随被删会话线性增长。内存侧每次 `getState()` 都会把这张表解析进来，几百条量级仍是几十 KB。

**误删一条绑定会发生什么（用户可见后果）**：该 DSH 会话失去「属于哪张卡/哪个聊天、用哪个架构与上下文模式」的记忆。用户重新打开这个会话时它按普通 DSH 会话工作（没有角色注入、没有酒馆楼层投影、工具面按非绑定会话装配）；聊天记录（`chats/`）、记忆、变量、正则脚本都还在，重新点一次激活即可重建绑定。**不会丢聊天数据**，但会丢「这个会话是酒馆会话」这个身份——这正是判据必须可证明的原因。

**回滚**：把开关移除即可；本特性不迁移、不加标记文件、不改数据格式，删除只发生在 `sessionBindings` 的键上。

## 开工前检查表

| 项 | 答案 |
| --- | --- |
| 1 所有者 | `packages/plugin/src/session/reclaim.ts`（唯一入口与判据）；`TavernStore.pruneSessionBindings`（唯一删除动作）。 |
| 2 唯一事实来源 | 绑定的读写仍是 `TavernStore.getState/updateState`；回收不另建索引。「谁还活着」以宿主服务与宿主存储为准，插件不落第二份。 |
| 3 持久态及理由 | 只删 `state.json` 的 `sessionBindings` 键；本特性自身不落任何持久态（无时间戳表、无标记文件、无「上次回收」记录）。 |
| 4 临时态 | 每轮回收的判据集合只在内存里活一次（一次 `apply` 一行日志后丢弃）；进程重启重新算。 |
| 5 外部依赖 | `ctx.agents.list`、`ctx.sessions.list`、`ctx.get('sessionPersistence').list/stat`、profile config 键 `pruneStaleBindings`。全部按 feature detection 使用，缺一个就整轮跳过。 |
| 6 注册入口 | `packages/plugin/src/index.ts` 的唯一一行 `void registerSessionBindingReclaim(...)`；现由 `runtime.store` 提供同一个共享 store 实例。 |
| 7 删除路径 | 见上一节。 |
| 8 兼容对象 | 旧 `state.json`（无该键）不受影响；`report` 盘面零写；客户端既有 `bindings/prune` 路由行为不变；`modelSelections` / `imPeers` 本次不动（见后续）。 |

## 验证

- 新增 `packages/tavern-store/tests/session-binding-prune.spec.ts`（4 条）：一次写盘删完 `remove` 内的候选并保留其余键的值、零候选时零写入（文件内容与 mtime 都不动）、**删除面是 `observed ∩ remove`**（调用期间别处新增、不在 `remove` 里的绑定不被删；`remove` 里但快照里没有的 id 不计入删除）。
- 新增 `packages/plugin/tests/session-binding-reclaim.spec.ts`（15 条）：默认关闭不打开 store/不读 state/不写字；非法值按 off 并 warn；`report` 判据分组计数 + 零写入 + 日志条数；`prune` 只删「宿主不认识 + 磁盘不存在」；活 agent、只给 `session.id` 的老宿主 agent、活会话、在盘会话一条不删；`prune` 整轮只进一次 `updateState`；`state.json` 其余键的值不变；`list()` 与写盘之间刚落盘的会话由 `stat` 复核保住；**判定与写盘之间新写入的绑定存活**（真实 `updateState`，且 `removed = stale`、`retained ≥ 0`）；活会话面缺失/会话条目读不出 id/存储面缺失/库存条目不完整/`list` 抛错/单条 `stat` 抛错六种 fail-closed 盘面全部零删除。
- 两个新增测试文件单独跑：**2 文件 / 19 用例通过**（4 条存储侧 + 15 条回收侧）。
- `pnpm vitest run packages/tavern-store/tests packages/plugin/tests/{tavern-command,session-activate,session-source-dispositions,agent-tavern-fork,store-revision}.spec.ts`：**18 文件 / 284 用例通过**。
- `node node_modules/typescript/bin/tsc -p packages/plugin/tsconfig.json --noEmit --composite false`：无输出（通过）；`packages/tavern-store` 同一命令无输出。
- 盘面结论按宿主契约推导，不依赖某台机器的数据：`SessionPersistence` 没有物理删除（见「已知边界」）、UI 删除是 archive 且保留目录与日志，所以常规使用下每条绑定都能被活会话面或磁盘库存认领，**候选天然接近 0 条**，`report` 输出 `stale: 0` 是预期结果。示例数据根上的只读观测（非验收基线）：表里的绑定都能在磁盘上找到工件；数量与字节数随卡库/宿主版本变化，不作为可复现的验收口径。

## 已知边界

- **在 DSH 0.2.0-rc.2 上这个回收几乎总是 0 条**：宿主没有「物理删除会话」的能力——`SessionPersistence` 抽象类的操作面只有 `create/open/flush/stat/list`，没有 delete/remove（`dsh-session-persistence/lib/types/index.d.ts:99-157`），UI 的「删除会话」是 workspace archive，契约明写保留目录与全部会话日志（`dsh-workspace/lib/types/index.d.ts:173`）。所以「磁盘上找不到」只在下列情况成立：用户手工清理/迁移了 sessions 目录、会话从未落盘就崩了（created-but-unmaterialized 才算从未存在）、或换用了会真删的存储后端。这是**有意**的结果：要删得更多，必须先用一个新的决策接受新风险（例如把「archive」当失效信号，代价是 unarchive 后绑定已丢）。
- 宿主契约缺失时退化成「永不回收」：`ctx.get('sessionPersistence')` 是宿主 seam——本仓库源码里没有对同名服务的其它调用点，`host-contract.ts:257` 只声明了 `get?(name): unknown` 的方法形状。真实 Cordis 探针验证过：`ctx.get` 对未 inject 的服务返回 `undefined` 而不抛，因此没有 `sessionPersistence`（或它晚于本插件提供）时整轮跳过并记 `reason: 'session-storage-unavailable'`，fail-closed。本特性只在 `apply()` 时跑一次，不会重试；下一次宿主启动再试。
- 任何一个 agent / session / 存储条目读不出 id，或 `stat` 抛错，整轮放弃。这个取舍是刻意的：一次损坏的工件不应该让「其它候选」被顺带删除，但代价是「一个坏会话会让本次回收完全不发生」。
- 多 DSH 实例并发：判定快照到写盘之间，另一个实例可能新建/落盘一个会话。收窄手段有三层——删除面是 `observed ∩ remove`（判定之后新写入的绑定不在 `remove` 里，不会被删）、`stat` 单条复核、以及「新建会话必然先有活 agent 或在盘工件」。剩余窗口是「另一个实例刚 create 但还没 flush，且本实例的 `stat` 也看不到」；此时若该 id 恰好有一条旧绑定，会被删掉。概率极低但存在，属于本决策接受的风险；`report` 阶段可以先在目标机器上确认候选数是否为 0。
- 只清 `sessionBindings`。`modelSelections`（同一会话的模型选择）与 `imPeers`（IM 对端 → 会话）仍由客户端的 `bindings/prune` 路由清理；它们不随绑定回收而增长失控（前者每会话一条、后者每条 IM 对端一条），若要一起清，应扩 `pruneSessionBindings` 并在同一决策里重新评估判据。
- 成本：显式开启时每个进程启动做一次 `sessionPersistence.list()`（需要读回每个工件的 header）+ 每个候选一次 `stat`。未做端到端计时（宿主未运行）；量级上是「启动期一次目录扫描」，不在任何热路径上。

## 后续

- 如果产品上想让「用户删掉的会话」真正回收绑定，需要单独决策：以 `workspaceRegistry.archivedSessionIds` 为第三信号（archive 且磁盘有工件也能删），并显式接受「unarchive 后会话失去酒馆身份」这个后果。
- `modelSelections` / `imPeers` 与绑定的生命周期应当同源，本次刻意只做绑定。
- `report` 的日志只有计数；`prune` 额外带 `removedIdSample`（前 20 条被删 id，总数看 `removed`），足以事后回答「删了哪几条」。更细的逐条排障仍应另开一条需要显式开启的 `verbose` 值，而不是把完整 id 列表塞进默认日志。
