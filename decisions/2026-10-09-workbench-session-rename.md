# 写卡会话侧边栏改名/删除（补记 fdbfd2c）

日期：2026-10-09。状态：已实施（补记）。相关：commit fdbfd2c；提案 0013（会话命名行）；`packages/plugin/src/index.ts`（card-workbench/rename 路由）、`packages/tavern-store/src/store.ts`（binding.title）。

## Problem

写卡工作台会话此前只能靠出卡自动命名（`nameSessionAfterCreatedCard`），用户无法显式改名；删除会话也没有工作台口径的入口。该批改动（fdbfd2c）落地时未附决策文档，本文件补记。

## Decision

三层落地（对齐酒馆聊天的侧边栏能力，用户显式意图最新者胜）：

1. **绑定层**：`TavernSessionBinding` 的 card-workbench 变体新增 `title?: string`（normalize 只收非空串；空串/畸形视为未改名，回落派生标签）。
2. **路由层**：`POST card-workbench/rename`——title trim + 200 字符上限；只认 card-workbench 绑定；错误码 `TAVERN_WORKBENCH`；非 workbench/未知会话 404、缺字段/空 title 400，fail-closed 不留半写状态。
3. **优先级与幂等**：`binding.title === undefined` 时 `nameSessionAfterCreatedCard` 才做宿主 rename——**用户显式标题压过出卡自动命名**（createdCard 照记，数据不丢，侧边栏标签保持用户的名字）；workbench-open 的幂等重发保留 `previous.title`。删除 = 解绑 + 归档，不删产出资产（卡/方案已落盘）。

## Alternatives considered

- **出卡改名无条件覆盖**：用户改完名再出一张卡就把标题冲掉，显式意图被隐式行为踩踏。拒绝。
- **rename 走宿主 binding.session.rename 单通道**：宿主标题不进 tavern-store，侧边栏分组与复用判定（数据源在绑定）看不到。拒绝。

## Consequences

- 测试锁定：`card-workbench-p3.spec.ts`（card_create leaves a user-renamed workbench session title untouched / rename 路由 404/400 fail-closed 矩阵）、`tavern-command.spec.ts`、`store.spec.ts`（title normalize）。
- 本文件为补记：实现先于文档落地，后续功能应先写决策再动代码。
