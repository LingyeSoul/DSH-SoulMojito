# ST 思考+正文双通道流式显示

> 日期：2026-10-11。需求：ST 模式下同时显示思考（reasoning）与正文的流式输出。
> 落点：`packages/plugin/client/main.js`（消费 + 渲染）、`packages/plugin/scripts/gates/run.mjs`
> （frontend-runtime marker）、`packages/plugin/tests/tavern-command.spec.ts`（服务端 SSE 契约锁）。
> 服务端零改动。

## 问题

服务端早在 runGeneration 就双通道流式（index.ts：`text-delta` → `{type:'delta'}`、
`reasoning-delta` → `{type:'reasoning'}` 逐 chunk SSE write），保存时思考也已落
`extra.reasoning` 与 `swipe_info[].extra.reasoning`。但客户端两个面都在丢：

1. `generateFor` 的 SSE 消费循环只处理 `start/delta/error/saved` 四种事件，
   `reasoning` 事件被静默丢弃——生成期间思考完全不可见；
2. `MessageRow` 从不读 `extra.reasoning`——保存后思考也不可见（纯数据，无渲染面）。

正文流式（`streamText` 伪楼层）本就工作；缺口全在思考通道。

## 方案（客户端三段，服务端零改动）

1. **消费**（generateFor）：`event.type === 'reasoning'` 增量累积进本地
   `streamedReasoning`，经 `setRun` 写 `run.streamReasoning`；`saved`/error/初始
   三处与 `streamText` 同步清空。
2. **伪楼层**（TavernView）：推入条件从 `run.streamText` 扩为
   `run.streamText || run.streamReasoning`——纯思考阶段（正文 delta 未到）楼层即
   挂出；reasoning 经 `extra.reasoning` 通道传入，走 MessageRow 与保存后消息
   **同一条渲染路径**。滚动跟随依赖数组补 `run.streamReasoning`。
3. **渲染**（MessageRow）：数据源 swipe 级 `swipe_info[i].extra.reasoning` 优先、
   回落消息级 `extra.reasoning`（各 swipe 候选有自己的思考；伪楼层与无
   swipe_info 的旧保存走消息级）。展开态 `useState(message.streaming === true)`：
   流式默认展开（思考实时滚动），保存后 key 变化（`stream`→`saved` 分段）重挂载
   自然回落折叠。思考块为折叠按钮 + 文本面板（`dt-reasoning*` 三段 CSS，虚线边
   框与正文气泡区分，max-height 280px 滚动防超长思考顶飞视图）；纯思考阶段正文
   为空时跳过空气泡（仅 `message.streaming` 时空正文隐藏，保存消息行为不变）。

i18n 新键 `message.thinking`（思考中…/Thinking…）/`message.thoughts`
（思考过程/Thoughts），zh/en 镜像由既有 locale gate 校验。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | client/main.js 的 generateFor 消费循环与 MessageRow 渲染；SSE 事件形状的所有者仍是 src/index.ts runGeneration（本次未动） |
| 唯一事实来源 | 思考数据 = 保存消息的 swipe_info[].extra.reasoning / extra.reasoning（服务端既有落盘）；流式中间态 = run.streamReasoning |
| 持久态 | 无新增——extra.reasoning 落盘早已存在，本决策只补显示面 |
| 临时态 | run.streamReasoning（saved/error/开始三处清空，进程内即可）；MessageRow reasoningOpen 展开态（组件本地） |
| 外部依赖 | 零新增——复用 /generate SSE 既有六种事件与 DSW 样式别名变量 |
| 注册入口 | 无新增路由/面板/slot——渲染进既有 TavernView 消息管线 |
| 删除路径 | 还原 main.js 三段（setRun 默认形状/generateFor 消费/伪楼层+MessageRow+CSS+i18n 四键）+ gates run.mjs 的 frontend-runtime marker 五条与负样本 + tavern-command.spec.ts 的 reasoningGeneration 桩与契约测试 |
| 兼容对象 | 旧消息无 reasoning → 思考块整块不渲染（零回归面）；正文流式/swipe 切换/编辑/分支行为不变；保存消息空正文仍渲染空气泡（仅流式伪楼层隐藏） |

## 否决项

- **思考并入 streamText 单通道（前缀标记分割）**：污染正文流式渲染（打字机正文里
  混思考文本），保存后又得拆回——双通道本来就在，单通道是倒退。
- **服务端新事件/新字段**：`{type:'reasoning'}` SSE 与 extra.reasoning 落盘均已
  存在，加字段纯属为改而改（Musk 第一步：question the requirement——需求缺的是
  显示面，不是协议）。
- **mod stream-delta 事件扩 reasoning 字段**：那是 mod 观察位（A-3 决策明示
  v1 只观察正文），与本需求的 UI 显示面无关，不捆绑。

## 范围边界（如实标注）

- 仅 ST 架构（用户明确「ST模式下」）。AgentTavern 走宿主 AgentLoop，思考流式
  由宿主原生渲染，插件无此缺口。
- STscript `/trigger` 经 `/script` 路由的生成是非流式 JSON——无流式中间态，但
  保存后消息的思考块可见（渲染路径共享）。
- 思考文本不进宏展开/AI_OUTPUT regex（服务端 REASONING placement regex 已在
  保存前跑过；流式中间态渲染原文，与「流式期间不执行」的既有保守策略一致）。

## 测试

- **服务端契约**（tavern-command.spec.ts 新 1 项）：reasoningGeneration 桩先吐
  reasoning-delta 再吐正文——断言 SSE chunk 序列含
  `{"type":"reasoning","text":"(inner reasoning)"}` 且正文 delta 通道不受影响；
  保存消息 `extra.reasoning` 与 `swipe_info[0].extra.reasoning` 均为全文。
- **client marker**（gates frontend-runtime 新 5 条 + 2 负样本自测）：
  `streamReasoning` / `event.type === 'reasoning'` / `dt-reasoning-body` /
  `'message.thinking'` / `'message.thoughts'`——负样本真移除 marker（沿用
  「替换不得以原 marker 为子串」纪律）。client half 是无出口 IIFE，行为对账
  走 marker（与 A-4 视口决策同模式）。
