# 决策：写卡工作台剧本编辑工具（script_get/script_put）裁剪

日期：2026-10-09。状态：已实施（补记裁剪）。相关：提案 0013（§2 资产工具表）、提案 0014（剧本库）、`packages/plugin/src/card-workbench/tools-material.ts`。

## Problem

提案 0013 §2 的资产工具表列有 `script_get/script_put`（剧本，读 0014），起始任务也含「改剧本」；但实现从未落地——KERNEL 的 Boundaries 明确把 scripts 划出工作台边界（`Other areas (extensions, scripts, chat state) are out of scope`），剧本在工作台只有只读面（`material_list`/`material_read`）。提案状态行声明「P1-P3 已实现」，与实际工具面不符，且该裁剪此前无决策记录。

## Decision

维持现状并正式记录裁剪：**不做** `script_get/script_put`。剧本的读取面由既有 `material_list`（列举 + 绑定卡）与 `material_read`（逐块读取、钳制、截断）承担——这两个工具就是事实上的 script_get；写入面（编辑剧本内容、新建/删除剧本）不进工作台。

理由：

1. 剧本写入的存储语义不匹配工作台的渐进编辑模型：`importScript`（tavern-store/scripts.ts）是「重名整本覆盖」的导入语义，没有块级编辑/局部更新 API；在工具层做「读全本→改→整本重导」会绕开确认协议的字段级 diff 语义，方案过期检测也无法落到条目粒度。
2. 剧本的产出端已有归属：剧本由用户在面板导入（`POST script/import`，含 EPUB），绑定/解绑走 `script/bind`；工作台的定位是「编辑卡/世界书/预设 + 排错」，把整本素材的再编辑纳入会显著放大工具面而无对应高频需求。
3. 从剧本制卡（0013 P3 起始任务）只需要读面：`card_create` 消费素材经 `material_list`/`material_read`，不要求写剧本。

## Alternatives considered

- **补实现 script_put（整本导入包装 + confirmed 闸门）**：与 preset_put 同款确认即可做，但整本覆盖的 diff 面板展示（几十块文本）在面板侧不可用，且重名覆盖语义对「改一段」场景过重——拒绝。
- **补实现块级 script_put**：需要 tavern-store 先建块级更新 API 与并发语义，属于 0014 存储层的独立演进，超出本次审查修正范围——拒绝，需要时另立提案。

## Consequences

- 提案 0013 §2 工具表对 `script_get/script_put` 标注已裁剪并引用本决策，状态行与现实一致。
- KERNEL 的 Boundaries 措辞保持不变（scripts out of scope 是刻意边界，agent 遇到剧本编辑请求应明说超出范围而不是绕路）。
- `tools-material.ts` 的模块头注明该裁剪，防止后续维护者「顺手补齐」。
- 工具面锁定：`card-workbench-tools.spec.ts` 对 22 个工具名的全序断言不含 script 工具，未来若恢复需连测试一起扩。
