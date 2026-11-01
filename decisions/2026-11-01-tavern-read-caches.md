# 决策：Tavern 热读面的指纹缓存、只读冻结与投影事件快路径

> 日期：2026-11-01。状态：已实施。相关：`packages/tavern-store/src/store.ts`、`packages/plugin/src/agent-tavern/projector.ts`、`packages/plugin/src/helper.ts`、`packages/plugin/src/generation/pipeline.ts`、`packages/plugin/src/mvu.ts`、`decisions/2026-10-29-body-read-freshness-and-group-cache.md`（同类读侧缓存先例）。

## 问题（实测）

- `state.json` 是单文件：约 3.3 MB，其中正则脚本约 1.7 MB、前端虚拟存储约 0.7 MB、会话绑定与其余约 0.9 MB。
- `TavernStore.getState()` 每次调用都 `readFile + JSON.parse + structuredClone(DEFAULT_STATE) + 归一化`，实测 11.3 ms；`getCharacter()` 每次 `readFile + 解码 PNG 卡`，实测 16.5 ms；`updateState()` 每次全量重写整份文件，实测 34.9 ms。
- 投影器对**每一个**新 session 事件都调用 `getState()` 与 `getCharacter()`。真实 v4 会话统计：每轮事件数中位 16、p90 61，其中 `step/start`、`step/end`、`tool/call` 一类事件合计 63%，而它们在 `projectMessages` 里必然返回 `[]`。
- 折算：每轮投影读取约 367 ms（中位）、约 1.4 s（p90），大部分花在永远不会产出楼层的字段时间上。

## 方案

1. **投影事件快路径**：`projector.ts` 新增 `PROJECTED_EVENT_TYPES`（`user/message`、`assistant/message`、`tool/result`、`agent/inbox/spliced`）+ `isBodyLogEvent`，构成 `canProjectEvent`。不可投影事件只推进并落盘检查点，不读 state / 角色卡 / 脚本覆盖层。分支放在原有 `try` 内部，写盘失败仍记录 pending 检查点后重抛，错误语义与旧路径一致。
2. **state 指纹缓存**：`readState()` 先 `stat`，与缓存的 `size + mtimeMs + ctimeMs + ino` 四元组相等即返回缓存对象；不等则重新读盘解析。外部进程改写、手改文件都由指纹发现，不依赖进程内失效通知。缺文件时以「absent 指纹」缓存 `DEFAULT_STATE`。
3. **角色卡指纹缓存**：按绝对路径 LRU（每实例上限 32），同一指纹命中即返回；三次卡写入（导入/更新/删除）后清空缓存兜底。
4. **只读冻结契约**：`getState()` / `getCharacter()` / `updateState()` 返回共享的深冻结对象，调用方必须只读，原地修改在严格模式下抛 `TypeError`。选它而不是每次返回副本，是因为对 3.3 MB 已解析 state 做 `structuredClone` 实测 3.53 ms，正好抵掉缓存收益；深冻结本身实测 0.46 ms 且只在缓存填充时发生。
5. **调用方改为持有可写副本**：`helper.ts` 的 `scriptGlobals`（深层点路径写入，用 `cloneJson`）、`generation/pipeline.ts` 的模板 global、`mvu.ts` 的 MVU global（均为扁平标量，浅拷贝足够）在冻结树之外各持一份可写副本，比对与落盘都改用副本。

## 否决项（实测后放弃）

- **每次 `getState()` 返回 `structuredClone`**：3.53 ms/次，把 11.3 ms 只降到约 4 ms，收益与复杂度不匹配。
- **写盘成功后 `stat` 再入缓存**：`writeAtomic` 与 `stat` 之间若另一个写者落盘，本实例会把旧 state 挂到新字节的指纹下，此后永久命中陈旧值，且下一次写会整份覆盖别人的写入。改为**写后清缓存**，缓存只在读路径产生。
- **只在测试环境冻结**：双模式开关会让生产跑在与测试不同的契约上，拒绝。
- **写后内容哈希自校验**：读路径仍要读整份文件才算得出哈希，等于没省。

## 与预期的偏差（据实记录）

- `updateState()` 实测 34.90 → 34.76 ms，**基本持平**：读盘那部分省掉了，但写后清缓存让下一次写重新读一遍，加上返回值改为「刚写入字节的解析结果」（保证返回值与磁盘读出的形状一致），两笔开销把它抵平。写放大不在本次范围，见下。
- 每事件一次 checkpoint 写盘仍在（约 0.5–1 ms/事件，每轮约 8 ms），本次未动。
- 缓存是**每 store 实例**一份；插件内同一数据根存在 7 个 `TavernStore` 实例，最坏 7 份已解析 state 对象图常驻。
- 非投影事件不再经过 `getState()`，因此 store 读失败不会再在这些事件上暴露成投影 pending；下一个可投影事件会重新读取并如实报错，楼层不丢。

## 验证

- 新增守护测试（`agent-tavern-projector.spec.ts`）：钉住 `PROJECTED_EVENT_TYPES` 与 `projectMessages` 分支字面量集合一致，并验证集合内每个类型确实走进投影路径（而非被快路径静默跳过）。
- 本机实测对照：`getState` 11.30 → 0.10 ms、`getCharacter` 16.51 → 0.13 ms、单事件读取对 22.95 → 0.06 ms。
- 全量 `vitest run`（188 文件 / 3173 用例）与 `packages/plugin/scripts/gates/run.mjs`（20 项）通过；三个调用方各有一条模板/ MVU 变量写穿的落盘验证。

## 影响面

- 对外扩展（Mod、面板脚本、后续新代码）拿到 store 返回值后不得原地修改；这是新契约，需要写进扩展文档。
- 冻结只覆盖 store 返回面，聊天记录快照（`getChatSnapshot`）维持原有的独立副本语义。

## 后续

- 把正则脚本与前端虚拟存储从 `state.json` 拆成独立文件，让写路径只 patch 目标切片（本次未做，是 `updateState` 34 ms 的真正来源）。
- 投影检查点批量落盘，替换「每事件一写」。
- `bootstrap` 每次回传整份 state（约 2.4 MB JSON）与客户端 11 个独立轮询定时器。
