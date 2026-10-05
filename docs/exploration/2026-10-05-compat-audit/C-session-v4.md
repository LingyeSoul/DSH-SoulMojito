# 审计 C · 会话格式 v4（已完成 2026-10-05）

宿主基准：`.npm-cache/dsh-runtime/node_modules/@deepseek-ai/`（0.2.0-rc.2）
总评：v4 准入是**三层规则**（source 行级 / 事件词汇表 / turn-step 关系），既有 3 个点修只覆盖第一层；第二、三层各埋一个必炸点，均"append 成功 + 异步落盘成功 + 加载期爆炸"。

## 必修（❌）

1. **`assistant/chunk` 未知事件类型** — `src/index.ts:2556-2563`（recordTavernSessionChunk）+ 调用点 `index.ts:2087`（llm.stream 循环内每 chunk 一次）。
   - 宿主：KNOWN 表无此类型（`dsh-session/lib/index.js:79-139`）；v1→v2 已退役（`dsh-session-format-v1-to-v2/lib/index.js:6`）；append 不查词汇表（`dsh-session/lib/index.js:1441-1461`）→ 写入静默成功；加载期 `SessionFormatUnsupportedError` 整会话拒载（`dsh-session-persistence/lib/index.js:182-184`）。
   - 症状：ST 模式 0.2.0-rc.2 上**每次生成必写毒**，下次打开会话即变砖；try/catch 永不触发。
   - 修复：v4 会话停发 assistant/chunk；如需 chunk 轨迹并入最终 assistant/message 的 stream 字段（宿主形状 `dsh-agent-loop/lib/index.js:1144-1150`）；v0-v3 会话维持现状。

2. **历史导入裸 assistant/message（turn:0 无边界）违反 v4 turn/step 关系** — `src/agent-tavern/projector.ts:317-336`（刻意不造 turn/start|end、step/start|end）；落盘循环 `index.ts:323-332`；违规形状被测试固化 `tests/agent-tavern-projector.spec.ts:261-266`。
   - 宿主：requireStep（`dsh-session-format-v3-to-v4/lib/index.js:573-575`：data.turn 必须等于 open turn+step）、assistant/message 走关系校验（lib:768-771）、turn/start 必须按 nextTurn 顺序（lib:746-747）；执行点 scanner finish()（`dsh-session-persistence-jsonl/lib/index.js:1071-1072`）+ v4 加载 validation:'current'（lib:2222-2225）。
   - 症状：AgentTavern 首次激活导入即毒化，会话下次加载拒载。
   - 修复：按 header.version 分支——v4 导入改为真实边界 turn/start{0}→step/start→消息→step/end→turn/end（导入 turn 0 完整开合与宿主 live turn 1+ 错开）；客户端折叠器无需改。
   - **冲突已裁决（主会话直读宿主源码）**：B 路正确。`dsh-session/lib/index.js` seed 边界的 `assertAssistantSettlementShape` 原文含 `!Array.isArray(data?.["stream"]) → throw "invalid settlement fields"`；`assertCurrentLlmShape` 对每条 `assistant/message`（及 assistant/attempt）强制执行。即 v4 写入缺 `stream` 数组 = 加载必炸。C 路只查了 v3-to-v4 关系层、漏了 dsh-session 的 settlement 层。
   - **合并结论**：historyImportAppends 在 v4 上要同时修「边界关系」+「stream: []」；index.ts recordTavernSessionAssistant（2565-2585）单独修 stream（B 路发现，C 路该条 ✅ 判定作废）；recordTavernSessionChunk 修词汇表（停发或并入 stream）。

## 建议修（⚠️）

3. **测试/gates 盲区** — 违规形状被测试固化；gates 无真实 v4 恢复探针（8271f20 的探针是一次性手工验证未沉淀）。修复：新增 gate，对插件可发射的每种事件流（ST trace 全序列 / agent-tavern 导入序列 / notice 序列）在 v4 stub 上跑真实 `assertReleasedV4Relationships`（从 .npm-cache/dsh-runtime 解析，同 repair 脚本 --runtime 机制）。
4. **repair-session-sources.mjs 修不了 v4 毒化** — 只能修 v0 source。A/B 类毒化（多余事件行/缺边界）需要新修复脚本（删 assistant/chunk 行 / 补边界或重写坐标），zstd 帧骨架可复用。
5. **finishTavernSessionTrace 边缘** — `index.ts:2589-2602`：step/end 失败被吞后仍无条件写 turn/end；宿主 turn/end 时若有 open step 拒收（lib:753）。修复：step/end 失败即终止 trace。

## 已验证 ✅

- 8271f20 source 修复模式正确且覆盖全部 8 个落 source 写入点；8908fb1 sessions.open 探测成立。
- occupyHostSession/beginTavernSessionTurn/step 边界/turn/end reason、agent-preset/selected、notice user/message、压缩路径（插件不直接写 compaction 事件，关系约束天然满足）、projector 只读路径——全部双侧证据闭合。
