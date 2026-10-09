# 决策：AgentNovel 认领释放路径（novel_unit_release）与跨 turn 认领的恢复通知

> 日期：2026-10-09。状态：已实施。相关：提案 0005（§6.2 执行令牌、§12 调度、§13 停止语义）、0007（§5.3 委托重派）、`packages/tavern-store/src/novel.ts`、`packages/plugin/src/agent-novel/agent.ts`、`packages/plugin/src/agent-novel/driver.ts`。

## 背景与事故

真实运行（novel `nvl-mv0o266v`，writerMode=inline）：`novel_unit_claim` 由 store 签发真令牌（48 位 hex，`randomBytes(24)`，哈希入账；驱动采样的工具输出 389 字节与真令牌长度逐字节吻合，全仓库与宿主 lib 均无全零生成逻辑），但模型侧只持有一个 32 位全零占位符——令牌在宿主→模型通道丢失（传输层脱敏或模型回显失败后虚构，均在本仓库边界之外）。随后：

- `novel_body_commit` 携假令牌被正确拒绝（`NOVEL_STALE_UNIT`，哈希不匹配）；
- turn 结束后 work-intent 记 delivered，claim 留存 → unit-1 永久 `claimed`；
- **死锁四面墙**：重领撞 `unit-in-flight`；`novel_unit_supersede` 拒绝 claimed 单元且该场景无已完成 commit；commit 永远哈希不匹配；driver 的 claimedSibling 短路（旧代码 `if (claimedSibling !== undefined) return`）令进度永久等待，agent 收不到任何能自救的消息。stall 暂停（6 turn）只 pause 不释放，resume 后同样死锁。唯一出口是用户手动 stop（§13）。

结构性根因：inline 写作模式假设模型能原样往返 48 位随机串——对 LLM 不成立（长随机串回显是已知弱项），且丢令牌后无任何 agent 侧恢复路径（0007 §5.3 只给委托模式定义了失败重派）。

## 决议

| 维度 | 处理 |
|---|---|
| store | 新增 `NovelStore.releaseClaim(novelId, { unitId, reason })`：claimed → prepared、attempt+1、清 claimedRevision/claimedRequirementSequence/hostTurn/executionTokenHash、reason 记入 lastError、`run.currentUnitId` 指向该单元时清空。单元处置与 `stop()`（§13）完全同构，但只动这一个单元、不动 run 状态。前置仅 `unit-not-found` / `unit-not-claimed`；空 reason 是 `NovelConfigError` |
| 工具 | `novel_unit_release { unitId, reason }`（author-only，作者绑定解析 + 委托写手拒绝的双重门，与 claim 同口径）。落在 0005 §6.2 的既有设计语言内："重试通过新的执行执行令牌沿用同一单元 ID" |
| 指引 | KERNEL 新增一条 stale 拒绝的处置纪律（禁止重试死 claim / 猜测令牌）；`novel_body_commit` 工具描述、supersede 的 claimed 拒绝文案同步指向 release |
| driver | claimedSibling 分支从静默 return 改为下发**恢复通知**：`write-unit` 意图携带该 claimed 单元 id，指令按单元状态分支——inline：「仍持有令牌则写+commit；令牌丢失则 release 后重领」；subagent：「再调 `novel_writer_delegate`（重派保留认领）；无法采纳（重启后注册表空 / §5.3 上限耗尽）则 release 后重新委托」。每 turn 边界至多一条（intent 机制去重），模型既不 commit 也不 release 的空转由 stall 预算（6 turn）兜底暂停 |
| 白名单 | `WRITER_ALLOW_LIST` 封闭集不收 release（委托写手不可释放认领），工具层再挡一道 |

## 变化与代价

- 旧行为"claim 存活期间 driver 完全静默"被有意取代：跨 turn 存活的 claim 其执行线程已断，静默=死锁。防重复 prepare（2026-09 修复）由新路径保留（claimed 单元不 re-prepare，沿用原 unitId）。
- 每个跨 turn 边界的 claimed 单元多一条通知消息（token 成本一条 notice，换取消除死锁）。
- 令牌往返通道本身（宿主/模型侧丢令牌）不在本仓库修复范围：本决策把它从"致命死锁"降级为"可自愈的一次 attempt 损耗"。

## 验证

- `packages/tavern-store/tests/novel-store.spec.ts`：`releaseClaim` 全生命周期（stale 提交 → unit-in-flight 锁死 → 释放 → 旧令牌作废 → 重领新令牌提交成功；非 claimed / 未知 ID / 空 reason 边界）。
- `packages/plugin/tests/agent-novel-tools.spec.ts`：`novel_unit_release` 工具往返（复刻事故：占位令牌 stale 拒绝 → 释放 → 重领提交）、工具面注册序、author-only 边界。
- `packages/plugin/tests/agent-novel-driver.spec.ts`：重写"claimed 存活"用例为**每边界一条恢复通知**（保留防重复 prepare 回归 + 单条防风暴断言）；新增 subagent 分支的恢复通知文案用例。
- 全量 vitest 843 通过；`tsc -b`、`build-plugin` 六 bundle、plugin gates PASS。
- 事故 novel 本体在修复期间被用户经面板删除（绑定一并清理），数据解锁不再适用；恢复路径由上述用例锁定。
