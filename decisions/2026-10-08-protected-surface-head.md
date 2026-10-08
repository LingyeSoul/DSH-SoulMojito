# v4 受保护 surface 头：导入防写 + 存量修复

日期：2026-10-08。状态：已实施。

## Problem

用户报告 AgentTavern 会话历史加载失败：

```
stored session "session-1e1ec8f8-…" is corrupt:
SessionFormatError: system/message requires a protected first surface head
(raw log: ~/.dsh/sessions/…/session-1e1ec8f8-…/session.v4.jsonl.zstd)
```

这是同一族会话损坏的**第四次**（前三次见 2026-09-30 producer source、
2026-10-05 turn 边界与 settlement），每次都是插件写入的事件形状差一个宿主
契约。本次差的是 v4 的 **surface 受保护头**：

### 根因

宿主 `foldSurface` 只在 `system/message` 追加到**空** surface 时建立
`protectedHead`；此后任何「surface 已有节点、受保护头未建立」的
`system/message` 追加都判整份日志损坏。而 0.3.x 的历史导入把开场白/历史
消息直接写成 surface 节点（`surfaceOp: 'append'`），从不写头 ⇒ 用户第一次
说话时 live loop 首步的 system prompt 提交
（`SystemPromptProjection` 对 surface 首个 system 节点的替换/追加）必然
踩中判定，会话从此不可加载。

关键陷阱：**这层校验在内存 append 时不执行**（实测：真实 `Session.append`
对无头 surface 上的 system/message 照单全收），错误只在异步持久化/加载边界
爆出——所以"写入成功"不能当证据，必须用加载路径回归。

### 取证（用户工件逐帧还原）

- 94,554 字节 = 69 个 zstd 帧、header + 168 行事件；`seq 8` 是导入的
  assistant 开场白（surface 首节点），`seq 18` 是宿主 system prompt——
  原样喂宿主机真实 `assertReleasedV4Relationships` 复现原文报错。
- 真实持久化栈 `open+read`（用户报错的同一条原生链路）逐字复现
  `stored log is corrupt: … protected first surface head`。

### 同批暴露的两个旁支缺陷

1. **修复脚本 v4 `--apply` 写单帧容器**：v4 读取器要求第一帧恰好一行
   header（`first frame is not exactly one header line`）；历史单帧写回产物
   能过脚本自验却过不了宿主读取。脚本此前的验证只跑关系准入，覆盖不到。
2. **v0 修复引擎从未进 git**：`.gitignore` 的全局 `lib/` 规则把
   `scripts/lib/` 静默忽略，48f3f74 提交的 `repair-v4-sessions.mjs` /
   `repair-tavern-import-turn.mjs` 引用孤儿模块，新检出上 import 即死。

## Decision

1. **导入前置受保护头（v4 专属）**：`historyImportAppends` 在 v4 会话且存在
   可导入消息时，先写 turn 1 / step 1 内的空 `system/message`（`append`；
   写入时 surface 为空，它即 `protectedHead`），历史从 turn 2 起。宿主首轮
   随后按自己的语义归一化它（替换头或追加新 system 节点），两条路径都合法。
   空内容不产生模型可见文本，也不参与投影。
2. **头的 source 必须恰好是 `{ kind: 'system-prompt' }`**（宿主
   `createSystemMessage` 形状）：恢复校验 `assertMessageEventShape` 要求
   system/message 带 system-prompt source——行准入与关系折叠都放行 plugin
   源，只有 seed/observe 层拦。此条已实测（`Session.create` seed 探针：
   plugin 源被拒、system-prompt 通过），并写入回归。
3. **v0-v3 不写头**：老宿主没有这条 fold，写入 v4 形状反而毒化老工件
   （2026-09-30 的 v2→v3 拒绝教训）；按 `session.header.version` 分支。
4. **存量修复（类 E）**：`repair-v4-sessions.mjs` 做与 `foldSurface` 同语义的
   surface 折叠，找第一个非法 system/message，在**第一个 surface 事件之前**
   补头：该处有打开的 step（老 greeting 先行导入）→ 头插进该 step，不引入
   重编号；只有打开的 turn（老 user 先行导入）→ 新开 step
   （`nextStep`）承接头并立即闭合，其后同 turn 的 step 坐标整体 +1。
5. **重编号与引用一致**：修复类 E 插入后按「最终排位建 seq 映射 → 重写全部
   引用」（`sourceEventSeqs` / `surfaceOp.startSeq,endSeq` / `data.headerSeq`
   / `data.messageSeqs` / `data.sourceEventSeq` / `data.throughSeq`），插入点
   之后的溯源链接随行号一致平移。
6. **v4 写回容器改双帧 + 写后原生 observe 门禁**：第一帧恰好一行 header、
   body 独立成帧；宿主可见布局（目录名 = session id）下 `--apply` 写回后跑
   真实持久化 `open+read`，失败回滚备份；clean 判定同样补一次 observe，
   不让"内容合法但容器坏"的产物被报成 clean。v4 验证从「关系准入」升级为
   「行级 `assertV4RowAdmission` + 关系折叠」双门。
7. **旁支修复**：`.gitignore` 增加 `!scripts/lib/` 例外（防止修复引擎再次
   被静默丢失）；两个脚本对 v0 引擎改懒加载，缺文件时 v4 修复不受影响、
   v0 工件如实跳过并给可执行错误；v0 测试组在引擎缺失时跳过而非变红。

## Verification

- **真实校验器复现与反证**：用户工件原始形状 → 原文报错；插入空头 + 重编号
  → PASS；修复后模拟宿主继续写（替换头 / 清空旧 prompt 节点 / 追加）→ PASS；
  无头对照 + live 首轮 → `protected first surface head`。
- **真实内存/seed 探针**：`Session.append` 接受头形状（也确认内存不拦非法
  形状，解释了腐坏如何落盘）；`Session.create` seed 校验拒绝 plugin 源头、
  接受 system-prompt 头；对头的替换（system prompt 归一化）合法。
- **用户工件端到端**：`--apply` 后原生 observe `OBSERVE OK: 169 events`；
  容器两帧、头在 surface 首位（`system/message@8 → assistant@9 → system@19`）；
  备份留存（`session.v4.jsonl.zstd.bak-*`）。
- **回归测试**：导入计划形状（头为 surface 首节点、turn 表整体 +1）、
  `liveTurn` 建模宿主 system prompt 提交（本次漏测的路径）、负向对照（无头
  导入 + live 首轮必须死于受保护头）、真实 seed 校验（source 形状正/反例）、
  tavern-command 端到端激活序列、修复脚本类 E 两形态（含引用平移断言、
  双帧容器与原生 observe 门禁）。
- `pnpm run check`：tsc + 57 文件 768 测试（2 skip：v0 组因引擎缺失）+ 插件
  构建 + 14 gates 全通过。

## Alternatives considered

- **不写头、导入消息改成非 surface（log-only）**：历史在原生会话里不可见，
  违背导入的产品目的。否决。
- **头带非空文本**：宿主 in-history 追加路径下会永久留在 surface 并对模型
  可见，伪造内容不可接受。空内容无模型文本。否决。
- **头用 plugin source 标记归属**（实现中途的真实错误）：能过行准入与关系
  折叠，但被 seed/observe 层 `must have system-prompt source` 拒绝；标记
  没有落点，去掉。否决。
- **全版本都写头**：v0-v3 无此 fold，多写事件毒化老工件。否决。
- **修复时搬移现有 system/message 到头位置**：system/message 的关系校验要求
  与打开的 turn/step 一致，位置不可搬；插空头是唯一保留全部坐标语义的修法。
  否决。
- **保持单帧写回**：被宿主读取器硬校验拒绝（本次实测）。否决。
- **重建 v0 引擎**：决策文档与测试规格不足以无损重建（展开空间、区间重映射、
  重试流分组），盲造坏用户老会话的风险大于收益；如实记录缺失并让路径显式
  失败。否决。

## Consequences

- 新导入的 v4 会话：surface 首节点是受保护头，live loop 的 system prompt
  提交（append/replace）合法；导入轮号整体 +1（`lastImportedTurn` 与
  `advanceHostTurnBase` 不受影响）。
- v0-v3 行为逐字节不变（dispositions v0 组与 tavern-command v0 用例对照）。
- 存量 v4 坏会话可修（类 E）且引用一致；修复工具的原生 observe 门禁覆盖
  双帧容器与 system-prompt 源两层，写回失败自动回滚。
- **未决**：`scripts/lib/session-turn-repair.mjs`（v0 turn 修复引擎）仍不在
  本检出/仓库中，v0 存量修复能力待该文件恢复后回归；v0 测试组以同条件跳过，
  不会假红也不会假绿。
- 宿主若在未来版本调整受保护头规则，导入遗留的空头是合法的空 system 节点
  （无模型可见文本、无 usage），最坏情况是多一个惰性节点，不损坏会话。
