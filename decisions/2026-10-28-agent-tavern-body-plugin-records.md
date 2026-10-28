# AgentTavern 正文状态的持久化：采用实验 plugin record

> 日期：2026-10-28。状态：已实现（工程验证通过）。相关：`docs/proposals/0021-agent-tavern-body-ops.md`、
> `packages/plugin/tests/agent-tavern-body-admission.spec.ts`、`packages/plugin/src/agent-tavern/body.ts`。

## 问题

提案 0021 需要为 AgentTavern 的“编辑正文 / 重生成 / 正文候选”保存一份可重建的 body ledger
（候选顺序、选中索引、编辑文本、未完成操作）。DSH Session 是唯一可重建的追加式事实源，
因此 ledger 必须落成 Session 日志记录。实现与契约测试发现：

1. `Session.append()` 没有写入 `ignorable` 的入口；宿主 v4 持久化与格式准入要求未知事件类型
   必须 `ignorable: true`，否则**整份会话拒载**。用 `Session.append('dsh-soulmojito/body')`
   会写出“当场成功、重启毒化”的记录。
2. 唯一可安全持久化且不进入模型面的官方出口是 `appendPluginRecord(session, type, data)`：
   它写 `ignorable: true`，宿主不识别时安全跳过，记录名遵循 `plugin:<owner>/<record>`。
3. 宿主 README 明确：`appendPluginRecord` 面向 `packages/experimental/`，仓库外插件“也不应
   调用”，同时说明没有仓库检查能约束外部插件。
4. 仓库测试缓存 `.npm-cache/dsh-runtime` 是 DSH `0.2.0-rc.2`，没有该 API；真机与全局安装的
   宿主是 `0.2.1-rc.2`。

## 决策

采用 `appendPluginRecord`，记录类型固定为 `plugin:dsh-soulmojito/body`；功能做版本门控：

- 宿主暴露 `appendPluginRecord` / `pluginRecordOf` 时启用 body 操作；
- 宿主缺少该 API 时返回 `host-unsupported`，**不**退回 `Session.append`，不静默降级；
- 投影定义 `createBodyProjection()` 注册为 `plugin:dsh-soulmojito/body`，并作为长期兼容 shim
  保留，不因功能开关关闭而反注册。

这是对宿主实验命名空间的显式依赖，属于本仓库既有的“版本敏感宿主 seam”范畴（先例：
`advanceHostTurnBase` 写 `agent.phase.lastTurn`）。依赖本身不改变 DSH 安装，不 fork、不 patch。

## 证据

- 契约测试 `agent-tavern-body-admission.spec.ts`：
  - 0.2.1-rc.2 真实 runtime：9 passed，覆盖 `appendPluginRecord` 正向、`pluginRecordOf`
    识别、无投影恢复原文、v4 准入通过；
  - 0.2.0-rc.2 缓存 runtime：7 passed + 2 skipped（缺 API 时明确警告后跳过）；
  - 负向：`Session.append` 写未知 required 事件，v4 工件准入抛
    `unknown event type "dsh-soulmojito/legacy-body"`。
- 本地最小复现：`appendPluginRecord` 返回 seq、事件 `ignorable === true`、同名投影把
  `deriveMessages()` 文本改为编辑值；未注册投影时原文不变。
- 宿主规则出处：`dsh-session` README「Write experimental plugin records」；
  `dsh-session` 持久化读取侧未知非 ignorable 拒载。

## 否决项

- **`Session.append` 写自定义事件**：v4 拒载整份会话，等于用 runtime 事故换功能。
- **纯标准事件路线（隐藏 ledger user/message + 每次编辑/切换生成 assistant 副本）**：
  可行且不依赖实验 API，但每次编辑/切换都新增 turn 与 assistant 副本，日志、turn 统计与
  turn rail 噪声显著；本仓库已有投影 seam 可复用，不选此路。
- **只写 Tavern JSONL**：模型面看不到选中/编辑文本，下一次请求与界面分叉。
- **patch / fork 宿主**：版本敏感、分发成本高；本提案前提是不 fork。
- **无持久化、仅进程内**：重启后候选与编辑丢失，不满足可恢复契约。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 实验 API 改名/移除 | 启动时版本探测；缺少即 `host-unsupported`；契约测试对 API 缺失显式 skip 并警告 |
| 宿主政策限制外部调用 | 本决策文档显式披露；发布说明标注实验依赖；不把该 API 用于宿主仓库内逻辑 |
| 投影卸载后 live 会话不可读 | 保留 projection shim；卸载/热重载提示；重启后 ignorable 记录安全跳过 |
| CI 缓存 runtime 落后 | 默认测试已实现三级回退（仓库缓存 → `NODE_PATH` → 全局 `npm root -g`）；本机命中全局 0.2.1 时 9/9，无 0.2.1 宿主时显式 skip + 警告；接线波次补 gate/CI runtime 方案 |
| 记录被 v3→v4 迁移改名 | 只面向 v4+ 写入；v3 宿主不启用该功能 |
| 记录内容跨版本漂移 | 读取时按 owner 校验 payload；未知/旧形状明确报错，不静默填空 |

## 删除路径

- 关闭功能：停止写入新 body 记录，保留投影 shim，旧会话仍可读。
- 彻底移除：`ignorable` 记录在插件缺失时被宿主跳过，会话可加载；编辑/选中效果失效，
  JSONL 的 `swipes` 保留。更新说明必须写明；不把 `plugin:dsh-soulmojito/body` 记录写进
  纯对话导出。

## 验证

- 2026-10-28 `npm run check`：153 test files / 2304 passed + 1 skipped；`build:plugin` 成功；
  18 道 gate 全部 PASS（含 `source-file-budget`、`v4-session-admission`、`client-bundle`）。
- `agent-tavern-body-*` 7 个 spec 共 92 条；runtime/wiring 拆片后各自聚焦测试与
  `typecheck:plugin` 通过。
- 未执行：真实 `dsh web` 浏览器端到端（编辑、重生成成功/失败、swipe 切换、MVU 拒绝、
  重开会话）。这是发布前剩余验收项。