# Mod 流式 token 事件（A-3）

> 日期：2026-10-11。来源：[JSR/LWB 竞品参考](../docs/exploration/2026-10-11-jsr-lwb-reference.md)
> §2.2/§4 的 A-3 建议（JSR 为 PolyForm NonCommercial——只复刻可观察语义，重新实现，
> 零代码拷贝）。落点：`packages/plugin/src/mods/events.ts`、`packages/plugin/src/mods/host.ts`、
> `packages/plugin/src/index.ts`（runGeneration 流式消费点）。开发者文档：
> [mod-api.md](../docs/mods/mod-api.md) §5。

## 契约

- **新事件 kind `stream-delta`**（events.ts）：payload
  `{ mode: 'send'|'regenerate'|'trigger', character, chatId, text, delta }`。
  `text` = 当前累积全文（JSR 的 fully 通道）、`delta` = 本次增量（incrementally 通道）——
  JSR 用两个事件分渠道，这里合成**一个事件双字段**，Mod 自选粒度，投递量减半。
  reasoning 增量不进事件（v1 只观察正文）。
- **发射点**（index.ts runGeneration）：`ctx.llm.stream` 消费循环的 `text-delta` 分支，
  `text += chunk.text` 与 SSE write 之后，每 chunk 一次。`character` 取发言者
  `speakerName`（与五相位 hook 的 context 同源——群聊时是说话成员不是群名）。
  finish(error/aborted) 抛出后循环退出，**停发是结构性的**（发射点在分支内），
  不需要额外开关。send/regenerate/trigger 三 mode 都过这一循环，全覆盖。
- **v1 范围（如实标注）**：只覆盖 ST 生成循环。AgentTavern 生成走宿主 AgentLoop，
  插件经 session 事件镜像，流式事件对 AgentTavern 不可达——mod-api.md §5 标注为
  v1 范围外。不进 iframe 下行（`dsh-tavern:mod-event`）：高频流式广播到浏览器面
  弊大于利，iframe UI 需要进度走自己的 HTTP 子路由拉取。

## 发射纪律（三个刻意选择）

1. **不背压生成**：发射是 fire-and-forget——不在生成循环里 `await` 投递。慢/抛错的
   handler 不允许节流 ST 的流式消费与 SSE 下行。这与 `chat-saved`（落盘点低频、
   inline await）刻意不同：stream-delta 每轮生成几十上百次，逐次 inline await 等于
   把任意 mod 的 handler 时延串进生成路径。
2. **投递保序**：单一 promise 链（`streamDeltaTail`）串行投递，同进程内 chunk 顺序
   不乱（打字机观察的正确性前提）。链尾永不被 reject（防御性 catch），否则一次
   异常会让后续所有 chunk 沉默。
3. **无订阅零开销**：`emitStreamDelta` 先查 `hasListeners('stream-delta')`，无监听
   一次 Map 查找即返回，不分配 promise 链节点。总线 `emit` 原有空 set 快路径不变。

## 审计防洪（首错纪律）

stream-delta 是逐 chunk 高频事件，handler 逐 chunk 抛错会刷爆 audit.jsonl（一轮生成
百条 event-error）。对齐宏「首错降级」纪律（host.ts macros.register 同款）：

- **判据是流代次（epoch）**：events.ts 模块级计数器，runGeneration 进入 llm.stream
  消费前 `beginStreamEpoch()` 递增。host.ts 的 events.on 包装在 catch 时比对
  `currentStreamEpoch()`：每代次（= 每次生成）每 Mod 只记第一条
  `event-error`，detail 为 `stream-delta: <msg> (further stream-delta errors for
  this generation are silenced)`；同代次后续静默吞掉。下一次生成代次递增，首错
  重新可审计（mod 修不好自己会持续暴露，一次不是永久静默）。
- **归因不漂移**：入队与投递分开计数——`emitStreamDelta` 入队时捕获全局
  `streamEpoch`，投递链把独立的 `dispatchEpoch` 换成该值、emit 完毕恢复；
  `currentStreamEpoch()` 投递中返回所投 payload 的入队代次。尾部排空晚于下一次
  生成开始时，审计归因仍指向 chunk 所属的旧代次；投递窗口内其他生成入队捕获的
  是不受投递影响的全局计数器。
- handler 失败本身不中断生成：总线 emit 逐个吞错（既有纪律），生成循环甚至不
  await 投递。其余三个 kind 逐次审计的行为不变（低频路径零改动）。

## 与五相位 hook 的分工

hook（generation-hooks.ts）是**变换位**（waterfall + 10s 超时降级），事件是**观察位**
（吞错不中断、无超时——handler 快慢只影响自己侧的投递链，不影响生成）。流式粒度
只在观察位开放：改写流式中间态会与 AI_OUTPUT regex / 模板渲染 / MVU 结算的终态
管线打架（JSR `before_end` 的改写位教训 + 本仓库「流式期间不执行」的保守策略，
参考文档 §2.7），v1 不提供流式改写。

## 测试

`packages/plugin/tests/tavern-mods-stream.spec.ts`（不动 tavern-mods.spec.ts——并发
施工避让）：send/regenerate 两 mode 的 payload 形状与累积 text 正确性、trigger 代次
推进、无订阅快路径、handler 抛错首错审计 + 同代次静默 + 新代次再审计 + 不中断生成、
dispose 反注册（disable 后 hasListeners 归 false）、未知 kind 注册期仍抛错。
