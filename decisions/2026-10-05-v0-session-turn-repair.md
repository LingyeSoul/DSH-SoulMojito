# v0 会话工件的 turn 坐标修复（history 加载失败闭环）

日期：2026-10-05。状态：**已实施**。取代
[`2026-10-05-import-turn-boundaries-and-settlement.md`](2026-10-05-import-turn-boundaries-and-settlement.md)
的存量数据部分（导入契约本身不变，本文补齐已落盘毒化工件的修复路径）。

## Problem

DSH `0.2.0-rc.2` 的会话 observe 走完整代际迁移链（v0→v1→v2→v3→v4）。
`~/.dsh/sessions` 下 dsh-tavern 写的 v0 工件带三类历史毒，整个会话在
`failed to observe session … refuses this format v2 Session: turn must be
positive` 处死亡，历史无法加载：

1. **孤儿 turn-0 导入**：`assistant/message { turn: 0 }` 无边界包裹
   （`repair-tavern-import-turn.mjs` 的 turn-0 盖章产物）。v2→v3 要求
   turn/step 为正。
2. **重复/跳号 turn/start**：占位空 turn 与 live loop 都开 turn 1
   （advanceHostTurnBase 之前的碰撞）。
3. **chunk 引用失真**：assistant 的 `sourceEventSeqs` 把 LLM 重试的失败
   组也算进引用（finish chunk 终结 attempt、重试开新组，assistant 只能
   cite 最终成功组）。

已有的 `repair-v4-sessions.mjs` 场景 C 专修 turn-0，但主循环只处理
`version === 4` 的工件——**v0 工件被无条件跳过**，修复从未生效。

## Decision

- **统一修复引擎** `scripts/lib/session-turn-repair.mjs`（纯函数）：
  - 孤儿导入 → 完整开/关的真实 turn（`turn/start`→`step/start`→
    assistant→`step/end`→`turn/end{completed}`），后续 turn 整体抬升；
  - turn/start 号统一校正（重复↑、跳号↓、零↑），保持从 1 连续稠密；
  - **展开空间重编号**：磁盘上 `reasoning-chunks`/`text-chunks`/
    `tool-call-chunks` 是列压缩行（`seq0`/`time0`/`dt`/`texts`），v0→v1
    迁移按成员数展开成 N 个 chunk，一行占展开空间 `[seq0, seq0+N)`——
    重写各行实际携带的序号成员，`sourceEventSeqs`/`messageSeqs` 的
    `[start, end]` 闭区间端点经区间映射逐点重映射；
  - **引用校正**只随 turn 修复触发（turn 干净的会话一个字节不动——
    老宿主 writer 的合法引用形状不同，普适 audit 是过度医疗）：按迁移
    分组规则回溯重算，回溯遇结算/边界/end-seed 即停；**LLM 重试流允许
    穿越恰好一个 finish chunk**（当前组终结符），第二个 finish 即停。
- **repair-v4-sessions.mjs 扩展 v0 支持**：v0 只做 turn 坐标修复
  （chunk 丢弃/stream 回填/source 归一化是 v4 专属语义，写入 v4 成员
  会毒化老工件）；写回前过客户端折叠验证，写回后过**真实宿主 observe**
  （persistence open+read，即报错原生链路），失败自动回滚备份。两帧
  容器：第一帧必须恰好一行 header。
- **毒源下线**：`repair-tavern-import-turn.mjs` 删除两个 turn-0 产出
  函数（`repairImportedPrelude`/`stampImportedTurnCoordinates`），主流程
  委托统一引擎；`verify-tavern-history.mjs` 适配 0.2.0-rc.2 的导出
  （persistence default export + `open(id,'read')` 入口）。
- 回归测试（`repair-v4-sessions.spec.ts` v0 组）：合成毒工件（含压缩行
  与区间引用）修复后必须过真实宿主 observe 且复检 clean；**健康 v0 工件
  必须字节不变**。

## 实施结果（2026-10-05，tavern-workspace 全量）

269 个工件：修复 15 个（13 个 turn-0 + 2 个重复 turn/引用复合），宿主可见
38 会话 observe 通过 **19 → 34**。剩余 4 个如实上报、不盲修：
3 个 `format v2 surface before first step cannot acquire a system head`
（0.1.x 时代 preset 切换会话，无 turn 结构，属另一族 chronology 病）；
1 个 `inherited Session cut splits one Assistant attempt`（end-seed 切在
attempt 中间，修复需挪动继承切分，语义风险大于收益）。

## Consequences

- turn-0 形状从「脚本仍会产出」变为「任何路径都不再生产，存量可修」。
- v0 工件的展开空间模型（一行 N 号、区间引用）是修复与今后诊断的基础
  事实；密集重编号与宿主内存迁移的 seq 语义一致。
- 引用校正与 turn 修复绑定触发、健康工件零改动，是 2026-10-05 一次
  258 会话过度医疗事故（全部回滚，零损失）换来的硬约束。
