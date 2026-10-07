# 提案 0013：卡片 Agent 工作台 — dsh-tavern 功能复刻（设计）

> 状态：提议（设计中，未实现）。日期：2026-10-07。参照物：`flizzywine/dsh-tavern`（AGPL-3.0）
> 公开功能文档（README「对话式修改人物卡」「自助调试 Agent」、feature-inventory H01–H09）。
> clean-room：只依据行为规格，实施时禁止阅读其源码。

## 1. 目标行为（从公开文档归纳）

- 通过**对话**修改人物卡 / 世界书 / 预设 / 剧本：描述不喜欢什么、想怎么改、保留什么；
  Agent 读资源 → 给方案 → **确认后写入**工作版。
- 从小说 / 剧本 / 素材**提取人物**制作新卡；也可从想法空白开始做卡。
- **游玩排错**：把实际游玩记录与日志交给 Agent，分析正则/美化/正文问题并修改资源。
- **原版 / 工作版分离**：导入保留原版，日常编辑工作版，可恢复原版。

## 2. 本仓库落点

本仓库已有决定性优势：`tavern-format`（卡/世界书/预设读写）+ `tavern-store`（原子写）+
`dsh-agent-presets`（preset 组合）。工作台 = **一个 agent preset + 资产工具面 + 确认协议**，
不是新的执行循环：

| 组件 | 决策 |
|---|---|
| preset | `card-workbench` preset：工具 + 提示词（讨论→方案→确认→写入），挂到独立工作台会话 |
| 资产工具 | `card_get/card_put`（工作版）、`world_get/world_put`、`preset_get/preset_put`、`script_get/script_put`（剧本，读 0014）、`card_restore_original`（恢复原版）、`chat_log_read`（排错用，读真实游玩记录） |
| 确认协议 | 写入工具必须携带 `planId`；方案先经 `card_plan_propose` 落库，用户在面板或对话确认后 `card_put(planId)` 才生效——对齐 flizzywine「先给方案，确认后写入」 |
| 原版/工作版 | `tavern-store` 卡目录增加 `.original` 快照（导入时写一次）；工作版即现有文件 |
| 排错入口 | 面板「交给工作台调试」：引用指定聊天 +楼层范围，工作台会话注入对应记录 |
| 起始任务 | 修改卡 / 改世界书・预设・剧本 / 从素材制卡 / 转 MVU（0012 P3）/ 空白开始 |

## 3. 阶段划分

- **P1**：preset + 读写工具 + 原版快照 + 修改卡任务（最高频路径）。
- **P2**：确认协议面板化（方案 diff 视图）+ 排错入口 + 世界书/预设任务。
- **P3**：素材制卡 + card-to-mvu（0012 P3）。

## 4. 明确裁剪

- 不做 flizzywine 的内置 Skill 库分发（create-skill/create-writing-skill 等）：DSH 宿主已有原生
  skill 机制，工作台只产生内容不经营 Skill 商店。
- 文生图、用户画像不在本提案（画像见独立调研结论，暂缓）。
