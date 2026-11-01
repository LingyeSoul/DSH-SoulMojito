# 决策：state.json 大资产切片化（写路径只写目标切片）

> 日期：2026-11-01（同日修订：迁移从读路径挪到写路径）。状态：已实施。相关：`packages/tavern-store/src/store.ts`、`packages/tavern-store/tests/state-slices.spec.ts`、`packages/plugin/src/generation/pipeline.ts`、`packages/plugin/src/mvu.ts`、`packages/plugin/src/helper.ts`、`decisions/2026-11-01-tavern-read-caches.md`（上一轮的读侧契约，必须延续）。

## 问题（实测）

- 本机 `~/.dsh/<home>/state.json` 共 **3,339,242 B**，按字节拆分：正则脚本 `regexScripts`（129 条）+ 两张归属表 **2,226,316 B**、`frontendStorage` **1,098,049 B**、其余轻量键只剩 **14,913 B**。两张表占了文件的 99.6%。（任务书给的 1.73 / 0.68 / 0.93 MB 是粗估，与实测不符；本决策以实测字节数为准，结论方向不变——写放大就是这两张表。）
- 旧 `updateState()` 一次全量写实测分解：`structuredClone` 4.53 ms + `JSON.stringify(3.34 MB)` 7.50 ms + 原子写 2.60 ms + 写后 parse-back 5.73 ms ≈ 20.4 ms（上一轮含读盘口径 34.9 ms）。触发点举例：`packages/plugin/src/generation/pipeline.ts:1009` 每轮命令写 `scriptGlobals`、`mvu.ts`/`helper.ts` 写脚本变量、面板路由写设置——全都为了几百字节改 3.34 MB。
- 上一轮已把读侧做成指纹缓存（`getState` 11.30 → 0.10 ms）与只读冻结契约；本轮不能回退这两点。

## 布局

```text
<data root>/
├── state.json             # 轻量键（14,913 B）：会话绑定、开关、scriptGlobals、chats…
├── regex-scripts.json     # { version: 1, regexScripts, regexScriptOwners?, regexScriptPresetOwners? }
└── frontend-storage.json  # { version: 1, frontendStorage }
```

- 每个切片自带 `version`（`STATE_SLICE_VERSION = 1`，`store.ts:549`），版本不符**抛错**并带上文件路径，不猜测未来格式。
- 归属表缺省时**省略键**而不是写 `{}`：`normalizeState` 把「键缺失」读作「跑一次归属迁移」，`{}` 会被读成「已迁移、谁都不属于谁」。这个 `undefined` 语义是既有行为，切片必须保持。

## 读路径（`readStateSnapshot`，`store.ts:1959`）

1. 三个文件并行 `stat` 一次，取 `size + mtimeMs + ctimeMs + ino`（沿用 `statChatFile` / `sameOptionalFingerprint`，不另发明指纹）。
2. 三份指纹全中 → 直接返回共享的冻结 state（实测 0.05 ms，热路径没有回退）。
3. 否则**逐文件**判断：指纹没动的复用缓存里的解析结果，动了的才重新读+解析。
4. `assembleStatePayload`（`store.ts:3006`）把 state.json 与切片合并（**切片优先**，见崩溃窗口）→ `normalizeState` → `deepFreeze` → 入缓存。

第 3 步是本轮的关键：轻量键写完之后 state.json 变了、切片没变，下一次读只重解析 14.9 KB，不会重新解析 2.2 MB 正则。

**读路径永不写盘**：只 stat / read / parse，不 `writeAtomic`、不建目录、不改 mtime。存量单文件（state.json 里还嵌着大表）在内存里就是数据来源，读出来的值不变，布局不动；迁移只发生在写路径（见下）。这条是硬约束：`packages/plugin/src/agent-tavern/projector.ts` 每个 session 事件都会 `await store.getState()`，读路径一旦写盘，只读盘上每个事件都会抛一次 EACCES 并重试一遍全量写，把「读还不降级」变成「读直接不可用」。

盘上连 state.json 都没有时返回 `DEFAULT_STATE` 的深冻结副本（`store.ts:508`），不走 `normalizeState({})`：后者会多出 `compaction` 与 `memoryEmbedding` 两个值为 `undefined` 的 own key（JSON 里看不见、`Object.keys` 里看得见），对外形状与改动前不一致。state.json 是提交点，没有它等于没有提交过状态；残留的切片是同一次写崩在提交前留下的孤儿，下一次写会用即将提交的值覆盖它们（`slicesToMaterialize`，`store.ts:3054`）。

## 写路径（`writeState`，`store.ts:1665`）

1. 用引用比较判断本次 patch 触动了哪几片（`next.X !== current.X`；`update` 返回新对象，语义天然成立）。
2. **迁移就是写路径的一部分**：`state.json` 里还嵌着大表时，强制写对应切片——不然下面第 4 步把键删掉就等于删数据。`updateState` / `patchState` 因此是唯一的迁移触发点，存量单文件在第一次写盘时变成新布局。
3. 先写被触动的切片（`writeAtomic`），再写 state.json（轻量）——顺序固定，state.json 是提交点。
4. 用刚写下的字节回读组装返回值，保持「返回值描述磁盘字节」的契约（未重写的切片直接取 `next` 的同名值，它本来就来自同一份文件的上一次解析）。

`patchState` 直接走同一条写路径但不做 `structuredClone`（补丁看不到 state，没有要保护的东西），实测省约 5 ms。这个省略只靠三条不变量成立：`base` 是深冻结的共享快照、`update` 拿到的是 `structuredClone`、返回对象在 `writeState` 里再次冻结。去掉 `structuredClone` 后回调拿到的就是 `base`：就地改数组再原样返回（`s.activeWorlds.push(x); return s`）时引用没变，写路径按引用比较判定「没变」而跳过写盘，改动只留在内存；而 `base` 的冻结会让同一个写法直接抛——冻结与克隆是一条链上的两道防线。注释里把三条不变量和这个失效场景一起写死，作为给未来改这块的人的路标（`store.ts:1594`）。

## 迁移与幂等

- 触发条件：**写路径**发现 state.json 仍带 `regexScripts`/`regexScriptOwners`/`regexScriptPresetOwners`/`frontendStorage` 键（`legacyStateKeys`，经 `slicesToMaterialize`）。读路径只报告不落盘。**存量单文件不需要任何手动步骤**，第一次写盘即完成。
- 迁移 = 用当前内存值把切片写一遍 + 重写不带大表的 state.json。它复用写路径，不引入第二套落盘逻辑；迁移崩在中间时下一次读仍然正确（切片优先），下一次写收尾。
- 幂等：迁移只依赖盘面内容，没有计数器、没有标记文件。崩在任何位置重来一次，写的还是同样的切片字节与同样的 light payload；值不变、条数不变、字节不变（`state-slices.spec.ts` 的「迁移幂等」用例逐字节比对三份文件）。
- 迁移失败抛错（文件路径 + 哪一片），不静默降级成「装作已经迁完」；因为切片先写，失败时 state.json 字节不变，旧状态仍然可读可迁移。

## 崩溃窗口

| 崩在 | 盘面 | 下一次读 | 下一次写 |
| --- | --- | --- | --- |
| 切片写之前 | 三份都是旧值 | 旧值（state.json 未被碰过） | 正常迁移 |
| 切片已写、state.json 未写 | 切片是新值；state.json 是旧值且仍嵌着大表 | 切片优先 → 新值 | 重写同样的切片字节并去掉大表（收尾） |
| state.json 已写 | 三份都是新值 | 新值 | 普通写 |

任何一格都不会出现「state.json 说没有、切片也没有」：切片永远先于 state.json 落盘，而 state.json 的键只有在切片已经写好之后才会被删。读路径不替崩溃补提交，所以崩溃后的盘面会一直保持「state.json 落后」直到下一次写——这是有意的：读不能变成写。

## 升级窗口与恢复语义

切片由旧进程写回的大表与新进程的切片同时存在时，**切片优先**，state.json 里的大表被静默忽略，并在下一次轻量写时从盘上删掉。这**不是意外，是写进契约的取舍**（`assembleStatePayload` 注释 + `state-slices.spec.ts` 的「切片存在时 state.json 里的同名大表被忽略」用例）。

为什么不能自动合并：这个组合在字节上与「迁移崩在切片已写、state.json 未写」的崩溃窗口**完全不可区分**——两边的 `state.json` 都还带大表、切片都已存在、没有版本号也没有时间戳可以判定谁更新。合并规则必然在其中一个窗口里丢掉更新的那份：偏向切片就会回滚旧进程刚写的大表，偏向 state.json 就会回滚刚完成的迁移。两害相权，选「切片优先」并把它变成文档化的已知行为，而不是让代码在两个窗口之间赌。

三种真实情况会发生什么：

| 情况 | 盘面 | 结果 |
| --- | --- | --- |
| 旧进程仍在跑，本版本已经写过一次（切片已存在） | 旧进程把整份大表写回 state.json；切片是上一次新版本写的值 | 读：按切片算，旧进程在大表里的改动看不见。写：下一次轻量写把 state.json 的大表删掉，旧进程的这版大表永久丢失；旧进程随后的读仍然读得到它自己写的内容，直到它重启 |
| 只恢复了 state.json（切片丢失或从未生成） | state.json 带大表，切片的键完全不存在 | 读：大表就是数据来源，值一条不少；写：第一次写把大表迁进切片（正常迁移，无损失） |
| 只恢复了切片（state.json 丢失） | 没有 state.json，切片在 | 读：等同全新安装，返回 `DEFAULT_STATE`（state.json 是提交点）；写：用即将提交的值覆盖这两个孤儿切片 |

**运维规则**：升级前先停掉旧版本进程（宿主重启即可），再让新版本写盘。不要在同一数据根上让新旧两个版本交替写。只恢复 `state.json` 是安全的；只恢复两个切片是不安全的（会回到全新安装）。

## 否决项（实测后放弃）

- **每次仍然写整份 state.json**：34.9 ms 就是它，拆切片是唯一解。
- **迁移放在读路径（首读触发）**：实测量级上看起来只是「一次性 33 ms」，但 `projector.ts` 每个 session 事件都会 `getState()`，只读盘上每次读都会抛 EACCES 并重试一遍全量写（假数据 129 ms/次，真实 3.34 MB 35 ms+），把「只读场景降级可用」变成「只读场景直接不可用」。改动前读路径永不写盘，这条不能退回；迁移必须在写路径（`writeState` 反正要重写 state.json）。
- **切片与大表自动合并**：见「升级窗口与恢复语义」，两个窗口在字节上不可区分，任何规则都会在其中一个窗口丢数据。
- **迁移时先删 state.json 的旧字段再写切片**：中间窗口里数据只存在于内存，崩溃即丢，直接违反「不要在任何路径上删除用户数据后又不落盘新文件」。正确顺序只能是切片先落盘。
- **写成功后 stat 再填缓存**（上一轮否决项的延续）：本轮不伪造指纹，改为「只把 light 半边标 stale」（`markStateCacheStale`，`store.ts:1710`），切片半边继续用各自指纹判断。
- **写后清空整个缓存**（上一轮的做法）：会把 2.2 MB 正则一起丢掉，下一次读要重解析约 5.7 ms，正好把上一轮的读侧收益退回去。
- **每脚本一个文件 / 每角色一个文件**：129 个文件、写一条要动多个文件、目录遍历变热路径；两片正好对应两种写频率（正则写入罕见但整表重写，前端存储高频小改）。
- **迁移放在 `TavernStore.open()`**：`open` 目前只做 mkdir，插件同一数据根最多开 7 个实例，并发 open 会抢写；写路径触发一次已经覆盖所有入口。
- **给 state.json 加 `version` 字段**：会被 `normalizeState` 的 `...rest` 透传成 `TavernState` 的新键，破坏「对外形状零变化」；迁移判定用「键是否还在」已经足够。

## 与上一轮契约的关系

- 只读冻结不变：`getState()` 仍然返回深冻结的共享对象，缓存命中即返回同一个引用。
- 指纹缓存不变，粒度从 1 份变成 3 份；缓存条目里每份文件各留自己的指纹与解析结果。
- `updateState` / `patchState` 签名不变，返回值仍是「磁盘字节的解析结果」。
- 上一轮的「读路径永不写盘」在本轮修订后原样恢复（首版曾把它换成首读迁移，已撤销）。
- 上一轮的「写后清缓存」换成「写后标 stale」——这是唯一有意改动的读侧动作，理由见否决项。
- 没有 state.json 时返回值的 own-key 集合与改动前一致（`DEFAULT_STATE` 副本，不多 `compaction`/`memoryEmbedding` 两个 undefined 键）。

## 验证

- 新增 `packages/tavern-store/tests/state-slices.spec.ts`（14 条）：存量单文件读出、**读路径只读不写（字节与 mtime 不变、切片一个不建）**、首次写触发迁移、迁移幂等（三份文件逐字节一致）、轻量键写不动切片、正则写不动前端切片、外部手改切片被指纹发现、**切片存在时 state.json 同名大表被忽略（升级窗口契约）**、切片写失败时 state.json 字节不变、写路径迁移不丢数据、崩在中间重来一次结果相同、**只读盘探针（rename 全 EACCES：读不抛错不写盘、写仍抛）**、**无 state.json 时键集合与改动前一致**、**只有切片没有 state.json 时读是全新安装、第一次写覆盖孤儿切片**。
- `pnpm vitest run packages/tavern-store/tests`：12 文件 / 200 用例通过（含新增 14 条）。
- `pnpm vitest run packages/tavern-store/tests packages/plugin/tests/{store-revision,tavern-command,card-workbench-tools,tavern-mvu,helper-route}.spec.ts`：17 文件 / 335 用例全绿。
- 真实规模副本实测：本机数据根已迁移，故用 `state.json` + 两切片重建的 legacy 单文件副本（**2,551,209 B**，129 条正则、1.07 MB 前端存储）在系统临时根上复测。上一轮的 3,339,242 B / 34.9 ms 是更大数据集的数字，不能与本轮逐项对比，因此补一列「同数据集复刻的整份写成本」。

| 指标 | 旧（整份写，同数据集复刻） | 新 |
| --- | --- | --- |
| `state.json` 字节 | 2,551,209（legacy 单文件） | 14,933 |
| 切片字节 | — | 2,174.1 KB（正则）+ 1,072.3 KB（前端） |
| `getState()` 冷读（legacy 布局） | — | 10.9–13.7 ms（只读：mtime 不变、切片未生成） |
| `getState()` 热读平均 | 0.10 ms（上一轮，3.34 MB 数据集） | 0.117–0.121 ms（legacy）/ 0.077–0.085 ms（迁移后） |
| `updateState({scriptGlobals})` | 31.4–41.8 ms | 9.1–11.1 ms |
| `patchState({activeCharacter})` | — | 3.9 ms |
| `updateState({regexScripts})`（2.17 MB 真写） | — | 41.6–42.2 ms |
| 首次写 = 迁移（一次性） | — | 42.2–49.5 ms |
| 只读盘：`getState()` ×2 期间的 rename 次数 | 首版：每次读都抛 EACCES + 重试全量写 | **0**（11.2 ms 冷 / 0.21 ms 热，字节不变） |
| 只读盘：`updateState()` | — | 抛出（5 次 EACCES 退避后，145–159 ms），state.json 字节不变 |

读侧成本归因：热读只剩 3 次 `stat`；冷读 legacy 布局要把 2.55 MB 读进来 + `normalizeState` 重建 1.07 MB 前端存储。写侧成本归因：`updateState` 的 9–11 ms 里约 3.5 ms 是 2.55 MB 的 `structuredClone`（可变回调契约），其余是 `normalizeState` 与 `writeAtomic` 的固定成本；`patchState` 没有克隆，3.9 ms。两次复测（同机、并行跑其他任务）取区间。

## 偏差（据实记录）

- 轻量写没有降到「只写 15 KB 就该是 0.2 ms」：剩下的是 `structuredClone`（`updateState` 的可变回调契约）+ 1.5 ms 量级的 Windows `writeAtomic` 固定成本 + `normalizeState` 重建 1.07 MB 前端存储。
- 真实正则重写仍在几十毫秒量级：这是重写 2.17 MB 资产的固有成本（stringify + 写盘 + 回读），不是布局问题。日常高频路径是轻量键写，它降到 9.1 ms / 3.9 ms。
- 迁移从读路径改成写路径后，**第一次写**多付一次迁移成本（本数据集 42.2 ms，含写两块切片与回读）。首读不再有 33–35 ms 的一次性开销，只读场景完全无写。
- 读路径每次多 stat 两个文件，热读仍在 0.1 ms 量级（同机复测，没有可测到的回退）。
- 本机 `state.json` 旁边还留着 3 个历史 `.tmp` 残留（`state.json.<pid>.<ms>.tmp`，各 6–7 KB），是更早的写入被中断留下的，与本轮无关，未清理。

## 影响面

- 对外 API 零变化：`getState()` 返回的 `TavernState` 形状不变（仍带 `regexScripts`、两张归属表、`frontendStorage`），`TavernStore` 之外没有一处读取方需要改。
- 直接读盘的工具（仓库内没有）需要知道布局变了；手改 `state.json` 里的 `regexScripts`/`frontendStorage` 在切片已存在时不生效——应改切片文件。
- **`state.json` 不再自包含，备份必须整套拷**：`state.json` + `regex-scripts.json` + `frontend-storage.json` 三份缺一不可。只拷 `state.json` 等于丢掉正则脚本/归属表/前端存储（切片已存在时 state.json 里没有这些键）；只拷两个切片等于没有提交过的状态（读路径按全新安装处理）。单拷 `state.json` 只在切片从未生成过（纯旧布局）时才完整。
- 读路径永不写盘：只读盘/只读数据根（预览生成、只读挂载）可以正常读；迁移发生在第一次写盘，读不会替任何崩溃补提交。

## 后续

- `updateState` 的 `structuredClone` 4.1 ms 是轻量写的最大单项。把回调契约改成「收到只读 state、返回新对象」可以一次省掉；这会动到上一轮写进文档的可变语义，需要单独决策。
- `normalizeState` 每次重建整张 `frontendStorage`（1.1 MB），可按角色惰性归一。
- 正则整表 2.23 MB 仍是整片重写；按脚本条目增量落盘只在高频改脚本的真实需求出现后再做。
- 上一轮遗留项不变：投影检查点批量落盘、`bootstrap` 回传整份 state。
