# 推演子 Agent 的前缀级复用（缓存成本优化）

日期：2026-09-10。状态：已实施。前篇：[2026-09-10-subagent-deduction.md](2026-09-10-subagent-deduction.md)。

## Problem

`tavern_deduce` 每轮每角色 `start('spawn')` 一个全新一次性子 Agent，
N 角色 × R 轮就是 N×R 个独立请求。原 `roleRoundPrompt` 把角色名与简报放在
prompt 第 1-2 行、轮次头插在 transcript 之前，每个请求从第 2 行起就与其他
请求分叉，provider 的自动前缀缓存几乎全部 miss：每个请求都全额 prefill
（继承的 system prompt 除外）。多轮推演的输入成本随轮次线性放大。

## Decision

- **复用做在请求前缀层，不做进程级复用**。one-shot `start` 的 run 是单轮
  句柄，没有"给同一个子发第二条消息"的同步 API；唯一的多轮通道是
  continuable（`startContinuable`/`sendMessage`），但它是异步消息驱动
  （子回复以 agent-message 回流父会话，不经过 run.result），且强依赖
  sessionPersistence（缺失时 fail loud），对同步编排的推演工具是错误形状。
  provider 的上下文缓存按请求 token 前缀命中，所以让 N×R 个请求**共享尽量
  长的相同前缀**即可获得等效的缓存复用。
- **角色 prompt 固定为「共享体 + 角色尾段」**（`deductionSharedBody` +
  `roleRoundPrompt`）：共享体 = 指令、场景、历轮站位，对所有角色×所有轮
  **字节相同**；第 r 轮共享体 = 第 r-1 轮共享体**原样追加**站位条目
  （append-only，不重写已有文本、不插入含轮号的头行）。角色身份、brief、
  轮次措辞只出现在共享体之后的尾段。
- **时序配合**：轮间等上一轮全部 settle（既有站位依赖，同时让下一轮请求
  扩写的前缀在缓存里保持温热）；同轮 N 个并发请求共享同一前缀，首个请求
  填缓存、其余命中。
- **不变量**：子 Agent 继承父 preset 的 system prompt（同一父的全部子已
  天然共享）与 `toolFilter: { allow: [] }`（工具清单为空且稳定，不再引入
  前缀分叉）；`label` 里的角色名无缓存影响（descriptor 是 session 日志
  事件，不进模型上下文），保留用于可观测性。

## Consequences

- 从第 2 轮起，除角色尾段（≈brief 长度）外的全部输入按缓存命中价计费；
  同轮多角色亦然。R=3、N=5 时未命中输入从 O(N·R·全量) 降到
  O(共享体 + N·R·尾段)。
- 共享体只能放与角色无关的内容——将来若要给角色注入差异化资料（如角色
  专属记忆检索结果），加进共享体会破坏跨角色共享；届时应权衡按轮共享
  （放 transcript 段之后、尾段之前）而不是回填共享体。
- prompt 措辞受测试 mock 的正则约束（`You are "X"`、`Round N of the
  deduction`），改措辞需同步 `agent-tavern-deduce.spec.ts` 的提取器。
- 缓存命中依赖 provider 的自动前缀缓存（DeepSeek context caching 等）；
  无此机制的 provider 上该布局无额外代价，也不会更差。
