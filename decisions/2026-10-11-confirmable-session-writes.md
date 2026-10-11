# D-2 Confirmable Session Writes：宿主侧「必须成立」写入的读回验证

日期：2026-10-11。来源：docs/exploration/2026-10-11-jsr-lwb-reference.md §3.3/§4 D-2
（LittleWhiteBox 教训，Apache-2.0 只抄语义：宿主保存 API 可能吞异常/等锁超时静默不保存
——「写完 marker 后从服务端**读回验证**在场才继续」）。

## 开工前八项表（CONTEXT.md 纪律；规则晚于本文落地，补记于 2026-10-11 审查修复）

| 项 | 答案 |
|---|---|
| 所有者 | 协议核 `packages/bind/src/confirmable-write.ts`（confirmSessionAppend / landedPlanAppends）；接入点为 index.ts §2.1 表所列五处「必须成立」写入位 |
| 唯一事实来源 | 宿主会话日志本体（读回判在场 = readSessionEvents 对日志的直接观察）；插件侧绑定/状态事实仍在 tavern-store，不因协议改变 |
| 持久态 | 无新增——协议不落自己的状态，产物是宿主日志里的 marker 本身与 logger warn/error 行 |
| 临时态 | 验证过程内的读回与一次重试，进程内即弃 |
| 外部依赖 | packages/bind 对宿主 session 形状的既有适配（0.1.x `events` / 0.1.2+ `snapshotEvents()` / 私有 `log`）；日志不可读宿主上协议如实失败不硬造确认 |
| 注册入口 | 无路由/事件/面板——纯库函数，由导入批量/占位 turn 对/AgentTavern 预设 marker/ST 激活 marker/关闭 marker 五点调用 |
| 删除路径 | 删 confirmable-write.ts + bind/index.ts 导出 + 五处调用回退直写 + confirmable-write.spec.ts 与 agent-tavern-confirmable-writes.spec.ts + 本决策；行为回到直写形态，无数据迁移 |
| 兼容对象 | marker 幂等性前提由调用方保证（同 id selected、同 summary notice 重复无害）；ST 激活 marker 判据从绑定 diff 改日志在场（§4.1 自愈补写）；未知形状宿主从盲目信任改如实拒绝（§4.2）；tavern-command.spec 幂等断言已随改 |

## 1. 背景：本仓库的风险面在哪里

对 DSH 0.2.0-rc.2 隔离 runtime 的实测读码（`.npm-cache/dsh-runtime`）：

- `Session.append`（dsh-session/lib/index.js）**同步写入内存日志并返回带 seq/time 的
  落账事件快照**，坏数据在 append 现场抛错——已知宿主形态下「写返回值即确认」；
- 落盘（dsh-session-persistence-jsonl）是后台异步链，失败仅 `ctx.logger.warn`、缓冲
  保留——持久化层失败是**宿主自己的 durability 域**，插件没有 flush seam，不可验证。

那读回验证防什么？**跨版本宿主形状**（packages/bind 存在的全部理由）：插件必须兼容
0.1.x `events` 数组 / 0.1.2+ `snapshotEvents()` / 私有 `log` 等形状，未来宿主形态未知。
「append 正常返回但日志无痕迹」在写侧无法排除；一旦发生，受害的是**下游依赖该写入
成立的行为**——最重的一条是轮次基线推进：基线推进到未落地的轮号 → live 首轮撞号 →
v4 关系准入（`turn/start does not open the expected turn`）把**整个会话判损坏**
（agent-tavern-session-admission.spec.ts 的 stale 负向对照钉住的正是这个形状）。

## 2. 写入点盘点（插件 → 宿主侧状态）

改动后行号以 2026-10-11 工作区为准。

### 2.1 必须成立（已加读回验证）

| 写入点 | 位置 | 下游依赖（为什么必须成立） | 失败形态（v1） |
|---|---|---|---|
| 历史导入批量追加（turn/step 边界 + 镜像消息） | index.ts:503-546 | ①轮次基线推进依赖落账（撞号=会话损坏）；②「已启动」锁定与重复导入幂等判定读日志 | 读回对齐→干净前缀时后缀重试一次→仍不齐：一行 error + closeImportBracket 兜底 + 基线只推进到 `lastLoggedTurn`（读回值），按既有导入失败降级继续激活 |
| 占位 turn 对（occupyHostSession，ST 激活与写卡工作台共用） | index.ts:3688-3721 | 基线推进依赖；丢失则 live 首轮跳号判损坏；占位本身摘除 blank 草稿复用资格 | 逐条确认（turn/start、turn/end 各自读回+一次重写）→ 仍缺席：一行 error + 不推进基线（既有降级：只失去防复用保护） |
| AgentTavern 预设 marker（agent-preset/selected） | index.ts:446-471 | 宿主 agentPreset 投影只认日志里的 selected 事件（dsh-agent-preset-registry/types/session.js:18-28）；丢失=会话重载后失去 AgentTavern 身份 | 读回+一次重写（同 id 重复 selected 无害，投影取最后一条）→ 仍缺席：一行 error + 抛错，不落绑定 |
| ST 激活 marker（`Tavern: <character>` notice） | index.ts:549-580 | 客户端 view/composer 接管判据（client/main.js isTavernSession 扫 surface 里 plugin notice marker） | 读回+一次重写 → 仍缺席：一行 error + 抛错（绑定已落库，如实半激活） |
| 关闭 marker（`Tavern closed` notice） | index.ts:348-377 | 会话归档后客户端 composer 释放与日志关闭痕迹 | 读回+一次重写 → 仍缺席：一行 error + 抛错（绑定删除已提交，顺序既有） |

### 2.2 尽力而为（不加验证，读回成本 > 收益）

| 写入点 | 位置 | 理由 |
|---|---|---|
| `agent.inject` 预加载快照（AgentTavern preload notice） | index.ts:479-489 | 丢失只影响首轮上下文质量，不破坏会话结构与身份；宿主 inject 无独立读回面 |
| ST 生成镜像追踪（beginTavernSessionTurn / recordTavernSessionAssistant / finishTavernSessionTrace） | index.ts:3795-3925 | 写入本身已 best-effort（catch → `trace.logging=false`）；begin 每轮从日志**重读**推导轮号，静默丢失自愈为下轮重算。遗留缝隙：finish 里 `advanceHostTurnBase(trace.agent, trace.turn)`（index.ts:3920）按计划值推进——v2 候选改为 `lastLoggedTurn(trace.agent)` 读回值（一行），v1 不动（ST/原生混用会话 + 静默吞写 + 该路径推进三条件同时满足才成立） |
| anchor/opening 提醒消息 | agent-tavern/anchor.ts:186-207 | 经 `agent/pre-step` 决策消息注入，由宿主 loop 落账——不是插件直接持有的宿主写面；丢失只影响一轮注意力锚定，write-once 契约由宿主保障 |
| AgentNovel / CardWorkbench 预设 marker | index.ts:2607-2610, 2691-2693 | 与 §2.1 预设 marker 同模式；本次并发施工避开 agent-novel/工作台处理器区域，v2 一行接入同一协议 |

### 2.3 无需读回（写返回值即确认 / 非宿主侧）

| 写入点 | 位置 | 证据 |
|---|---|---|
| `advanceHostTurnBase` / `canAdvanceHostTurnBase` | index.ts:3697-3760 | 已内建读回：写入后回读 `phase.lastTurn === turn` 才返回 true；canAdvance 用同值回写探测冻结/只读 getter |
| `bindSession` / `db.updateState`（sessionBindings 等） | index.ts:3602-3640 | 插件自有 tavern-store，非宿主侧；原子写 + 失败即抛，无吞写面 |
| 投影器 saveChat / checkpoint | agent-tavern/projector.ts:117-171 | 插件自有存储；revision CAS + 4 次重试 + 失败上抛，协议完备 |
| lazy-projection 四通道写穿 | lazy-projection.ts | 插件进程内缓存，best-effort 是文档化契约（「失败只意味着下一次装配沿用旧缓存」） |

## 3. 验证协议（packages/bind/src/confirmable-write.ts）

单条 marker（`confirmSessionAppend`）：

```
append → sessionEvents() 读回 → present? → 是：成功（零额外写入）
                              → 否：append 重写一次 → 读回 → present? → 是：成功 + 一行 warn（退化宿主可观测）
                                                          → 否：一行 error（含写入点 label + attempt 1/2 结果）→ 返回 false，调用方上抛/降级
```

- 重写只在读回缺席时发生，在场即停——append-only 日志零重复；
- marker 幂等性是前提（同 id 的 preset/selected、同 summary 的 notice 重复无害），调用方保证；
- 日志形状不可读（readSessionEvents → undefined）时读回恒空 → 协议如实失败，不硬造确认
  （保守面：未知形状宿主上拒绝写入依赖，与既有「基线不可推进宁可跳过」纪律同向）。

批量 turn 结构写入（`landedPlanAppends` + index.ts 接线）：

- 按写入前日志长度 baseLength，从尾部逐条比对计划（type + data JSON 序列，宿主落账
  是入参快照、键序保持）得连续前缀 `landed`；
- `landed < total` 且 `日志长度 === baseLength + landed`（干净前缀，无残渣）→ 补写
  `plan[landed..]` 后缀重试一次——后缀接续密集轮号，不产生重复轮号；
- 尾部有**计划外残渣**（错位/异源事件）→ **拒绝重试**（重放必重复边界事件 = 损坏形状），
  error 行如实标注 `suffix retry refused`；
- 最终 `landed < total`：closeImportBracket 兜底关闭半个导入，**基线只推进到
  `lastLoggedTurn`（读回确认的最大轮号）**——以日志为准，不以计划为准。这一条独立于
  重试存在，是杀「吞写 → 撞号 → 会话损坏」链路的关键不变量。

可观测性：每个失败一行 `ctx.logger.error`，含写入点 label 与两次尝试结果（如
`attempt 1: 0/16 appends visible, attempt 2: 0/16`）；重写救回时一行 warn。

## 4. 行为变化（有意为之）

1. **ST 激活 marker 的追加分派从「插件库绑定 diff」改为「会话日志在场判定」**
   （index.ts:562-565）：marker 一旦丢失（此前吞写/宿主事故），重复激活会自愈补写。
   旧行为下 marker 永远补不回来，composer 从此不接管。tavern-command.spec.ts 幂等
   用例断言随之更新（修复重发现在补恰好一条 marker，turn 占对仍幂等）。
2. **未知形状宿主（日志不可读）上的写入从「盲目信任」改为「如实拒绝」**：旧逻辑在
   读不回日志的宿主上照样推进基线/落 marker；新协议读回恒空 → error + 拒绝/降级。
   宁缺勿滥的代价面，如实记录。
3. 导入成功路径 `advanceHostTurnBase(agent, importedTurn)` 改为
   `advanceHostTurnBase(agent, lastLoggedTurn(agent))`：正常宿主两值相等，行为不变；
   吞写宿主上前者会撞号判损坏。

## 5. 顺带发现（已修，2026-10-11 同批合入）

**客户端关闭判据失配**：client/main.js:2937（及打包产物 client/index.js:3110）以
`source.tavernState === 'closed'` 识别关闭，但服务端 close marker 自 v0/v4 source
形状收敛（8271f20 起）只写 `{form:'notice', summary:'Tavern closed'}`——初始提交
68d0858 曾写 `tavernState: 'closed'`，v0 disposition 封闭成员集
{kind,plugin,form,sections,summary}（session-source-dispositions.spec.ts）使该成员
不可合法保留。后果：已关闭会话若被重新打开，`isTavernSession` 仍按激活 marker 匹配。
**处置（同批落地）**：client `isTavernSession` 关闭判据改双轨——`tavernState === 'closed'`
（v0 遗留会话）或 `summary === 'Tavern closed'`（现行 marker），已关闭会话不再被
composer 重新接管。

## 6. 否决项

- **全局 hook 所有宿主写入**（包装 agent.session.append 统一验证）：marker 幂等性是
  逐点性质（turn 边界重复=损坏），统一协议必然对部分写入点错误重试；且绝大多数宿主
  写入是尽力而为（§2.2），读回是成本。逐点接入、宁缺勿滥。
- **对持久化层（JSONL 落盘）做读回**：插件无 flush seam；后台写失败由宿主 warn +
  缓冲保留自愈，进程内读回验证不了磁盘。不属于插件可验证面。
- **给 ST 生成镜像的 advanceHostTurnBase 加读回**（index.ts:3920）：成立条件三重
  稀缺（ST/原生混用 + 静默吞写 + 该路径），v1 不动，v2 一行改读回值（§2.2）。
- **AgentNovel/CardWorkbench 预设 marker 本次接入**：语义同款，但处理器区域属并发
  施工边界；occupyHostSession 共用函数的加固已顺带覆盖两处的占位 turn 写入。

## 7. 测试

- packages/bind/tests/confirmable-write.spec.ts：协议单元（首读在场不重写 / 重写救回
  + warn / 两次失败 + error 行含 label 与两次结果 / 不可读日志如实失败 / 批量对齐
  六边界）。
- packages/plugin/tests/agent-tavern-confirmable-writes.spec.ts：吞写宿主矩阵驱动真实
  桥接命令——全吞 ST 激活（重试发生、error 可观测、基线不推进、如实半激活）、瞬态
  吞（重写救回 + warn）、marker 丢失自愈、占位 turn 半落地（start 在场 end 被吞 ×2
  → 基线不推进）、预设 marker 吞（不落绑定）、导入全吞（降级 + 基线 0 +
  `attempt 1: 0/N, attempt 2: 0/N`）、尾部吞（后缀重试补齐、零 error）、错位残渣
  （拒绝重试 + 基线=读回轮号）、close 吞（抛错 + 两行重试痕迹）、不可读日志
  （激活抛错 + 占位不推进）。
- 回归：tavern-command.spec.ts 全量 43 用例（含幂等断言更新）；
  agent-tavern-session-admission.spec.ts 真实宿主准入 3 用例不变。
