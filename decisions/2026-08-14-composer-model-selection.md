# Composer 模型选择：按 session 持久化 + 自建目录端点

日期：2026-08-14

## 背景

Tavern composer 接管了 `conversation.composer`，原生 composer 的 `conversation.input.model` 座位随之一并消失，RP 生成只能使用 `agentDefaultModel` 的进程级默认模型，用户无法在聊天输入框切换模型或推理等级。

## 决策

1. **UI 复刻 DSH 原生 model seat**（`dsh-client-ui-model-selection`）：输入行右侧 pill 触发按钮（模型名 + Effort + 旋转 chevron），向上弹出的二级菜单（Model/Effort 两个 drill-in cell），模型按 provider 分组、sticky 组标题、选中项打勾、加载/失败/空态与 Retry。CSS 数值逐项取自原生 `ModelSelect.module.css`，类名前缀 `dt-model-`（根节点用 `dt-model-select`，避免与设置页既有的 `.dt-model` 类冲突）。
2. **目录数据自建端点，不复用 `session.models` RPC**：Node half 新增 `GET models`，用 `ctx.llm.listProviders()` + `listModels()` + `resolveModelInfo()` 装配，逻辑与 host apiproxy 的 `buildModelCatalog` 一致（per-provider 失败进 `failures`、空组丢弃、catalog 成员资格是建议性的）。理由：Tavern 生成不走 DSH Agent，`session.selectModel` 只影响 Agent 的下一次请求装配，对 `ctx.llm.stream` 直连的 Tavern 循环无效；自建端点让 client 无需依赖 `connection` 服务。
3. **选择按 session 持久化在 Tavern state**（`modelSelections: Record<sessionId, {provider, model, reasoningEffort?}>`），新增 `POST model` 写入，`bindings/prune` 一并清理。与原生"每会话一份选择"的心智模型一致，且不污染 `sessionBindings`（binding 保持纯 character/chatId，rename/delete 流程零改动）。选择模型时附带该模型的 `defaultEffort`（对齐原生 `/model` 行为）。
4. **generate 解析顺序**：body 显式 provider/model/reasoningEffort > `modelSelections[body.sessionId]` > `agentDefaultModel.currentSelection()`（含其 reasoningEffort 仅在 provider+model 与默认一致时沿用）。client 每次 generate 都随 body 发送当前选择，服务端保存值作为无 sessionId/无显式值时的兜底。

## 备选方案

- **调用 `session.selectModel` RPC**：被否，见决策 2——选择不会作用于 Tavern 自己的生成循环。
- **全局单一 Tavern 模型**：被否，粒度粗于原生 per-session 语义。
- **选择存进 `sessionBindings`**：被否，prune/rename/delete 都要额外处理混合形状，独立 map 更清晰。

## 后果

- 旧 `state.json` 无 `modelSelections` 字段时由 store 读入层补默认 `{}`。
- 目录为空的 provider 不会出现在菜单，但显式保存过的选择仍可路由（catalog 是建议性的），触发按钮此时显示 "Select model" 回退文案、不合成陈旧行——与原生一致。
- gates 的 `REQUIRED_SERVER_ROUTES` 增加 `models`、`model` 两条路由标记。
