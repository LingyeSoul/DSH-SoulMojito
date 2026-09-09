# 导入历史补 turn/step 载荷坐标，修复新建聊天空白

日期：2026-09-09。状态：已实施。

## Problem

0.3.1 的 AgentTavern 历史导入（fbf01ba「Import tavern history without synthetic
turns」）把开场白导出成不带任何坐标的裸 `assistant/message` 表面事件。DSH
0.1.2 的客户端会话折叠器里，`assistant-step` 对话定义从事件载荷直接读
`{ turn, step }` 坐标（`match` 用它们拼 context id，`buildLocationData` 发布
`{ kind: 'step', turn, step }` 位置数据），裸消息让 `data.turn` 为 `undefined`，
装配器在 flush 时抛 `conversation Definition "assistant-step" published invalid
turn undefined`。这个异常发生在 session-controller 的事件流订阅者里，订阅者
被整体打断，会话折叠再也无法推进——于是新建聊天激活成功、开场白也在事件
日志里，但「对话」区一片空白。

`scripts/verify-tavern-history.mjs` 为什么没拦住：它的窗口只喂
`turn/start` 事件，裸表面消息从不经过折叠；而且它按旧宿主的 region 名（
`sessions/conversation-assembler` 等）切 0.1.2 已改名的 bundle，在 0.1.2 上
直接报 missing source region，实际上从未跑过。

宿主侧 `Session.deriveMessages()` 对裸消息工作正常（表面折叠只看
surfaceOp），所以服务端一切自检无感。

## Decision

- 导入的 assistant 消息带显式 `turn: 0` 与自增 `step`（1 起）。客户端
  `ConversationLocationIndex` 对任意事件读 `data.turn/data.step` 并**隐式**
  创建 turn 容器，因此不需要 `turn/start|end` 边界事件：宿主 blank 判据
  （日志里存在 turn/start）保持 false，connectWorkspace 的 blank 复用与
  fbf01ba 的「live loop 拥有 turn 1」设计都不受影响。turn 0 与 live 首轮
  （lastTurn 默认 0 → 首轮 1）天然错开。
- `user/message` 保持宿主原生形状（消息本体、无坐标）；折叠器对 user 消息
  从 currentTurn 推坐标，不抛错。
- `repair-tavern-import-turn.mjs` 扩展为双形状入口：
  `repairImportedPrelude`（旧合成 turn 会话）保留 assistant 并**盖章**
  `turn: 0, step: 1`（原先删除坐标正是引入本 bug 的第一步）；新增
  `stampImportedTurnCoordinates` 给已裸化的导入 assistant 盖章，seq 不动；
  两者都无操作时输出 no-op。幂等。
- `verify-tavern-history.mjs` 重写：region 候选列表兼容新旧宿主布局（含
  dsh-client-runtime 在 0.1.2 缺失的情况）；注册 chat bundle 的完整对话定义
  集（assistant-step 在内）；**全量事件**过 `replaceWindow` + `flush` +
  分页。对坏 artifact 会精确复现生产错误，对盖章后 artifact 通过。

## Alternatives considered

- 恢复合成 turn/start|step/start 边界：正是 fbf01ba 修掉的结构（宿主侧
  replay/repair 问题），且会重新激活 blank 复用劫持，否决。
- 客户端补丁或 shim 修装配器：宿主 bundle 不可改，跟随升级会被冲掉，否决。
- 只修 repair 脚本、导入继续裸奔：每个新聊天都会复现空白，否决。

## Consequences

- 新建聊天激活后开场白立即渲染；带历史的旧聊天导入后同样在 turn 0 内
  按 step 展开。
- 存量 6 个含裸导入 assistant 的会话（86b15540、153ec6d0、102f7ecf、
  7e460ceb、ece63849、bfc1f967）事件日志已持久化，插件更新救不了它们：
  停机跑一次 repair 脚本即可（有 .bak 备份、幂等、宿主校验兜底）。其中
  已有 live turn 的会话平时看不出来，但回翻历史到导入页会复现同一崩溃。
- 导入 assistant 带 turn 0 不参与宿主 turnBoundary 投影（无边界事件），
  live 轮次编号不受影响；投影器 `turnAt` 仍只读 turn/start，行为不变。
