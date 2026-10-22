# 面板「行为设置」分区：散养行为开关收编，按行为对应关系分组

> 日期：2026-10-21。用户需求「改进管理面板交互」：把所有野生设置项（举例：新
> AgentTavern 会话开始时预载角色信息和常驻世界书条目、常驻世界书条目相关开关）
> 全部放进系统的行为设置中，并按行为对应关系分区。同轮追加：「新聊天架构」与
> 「AgentTavern 上下文」两个分段控件也一并迁入。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/client-src/83-ui-prompts.js`（新增 `BehaviorSettingsBand` + `ActiveSetupBand` 瘦身）、`90-panels-core.js`（分区注册 + 世界书清单摘开关）、`84-ui-chat.js`（设置页挂 band）、`30-games-ui.js`（游戏清单摘开关 + 自绘 `IconSlidersOutline16`）、`95-ui-styles.js`（`.dt-behavior-group` 规则，删 `.dt-architecture-settings`） |
| 唯一事实来源 | state.json 里的行为键一个没动（`tavern-store` 的 parse/默认值不变）；收编纯客户端渲染面迁移 |
| 持久态 | 不变：`defaultArchitecture` / `defaultContextMode` / `agentTavernPreloadAssets` / `nativeAgentPersona` / `worldFollowsCharacter` / `agentTavernAllowGlobalWrites` / `frontendAutoOpen` / `frontendAllowExternalResources` / `cardScriptsAutoRun` / `gamesDisableResign` 全部维持原键名、原默认值、原服务端逐次读取语义 |
| 临时态 | 无 |
| 外部依赖 | 无新增；宿主图标清单没有「调节/行为」语义图形，nav 图标按几何纪律自绘（16 网格、1px 描边、currentColor） |
| 注册入口 | 面板分区注册表新增第 19 项 `{ id: 'behavior', group: 'system' }`，system 组置顶（在 presets 之前） |
| 删除路径 | 还原各旧挂点（`ActiveSetupBand` 架构分支、世界书清单顶、游戏清单顶）即回旧形态；`behavior-settings-client.spec.ts` 的负样本断言会翻红提醒 |
| 兼容对象 | 原生设置页（`settings.section` slot）与面板总览共用 `ActiveSetupBand` 的先例沿用：同一个 `BehaviorSettingsBand` 双挂设置页与面板分区，设置页不丢任何此前可达的开关 |

## 收编前的问题（RCA）

行为开关此前散养在四个互不关联的面：

1. **「当前配置」架构分支**：`defaultArchitecture` / `defaultContextMode` 两个分段控件
   与 `agentTavernPreloadAssets` / `agentTavernAllowGlobalWrites` / `frontendAutoOpen`
   三个开关混排——前两者决定新会话形态，后三者是会话/工具行为，语汇不同级；
   且架构切到 ST 后三个开关整体消失，用户找不到。
2. **世界书清单顶**：`worldFollowsCharacter` 埋在资产列表第一行，和「激活哪些书」
   的清单语义抢位置。
3. **游戏清单顶**：`gamesDisableResign` 埋在开局列表的 hint 段里。
4. **设置页与面板总览双挂点**：`ActiveSetupBand` 同时出现在原生设置页与面板总览，
   同一份开关两处渲染，本身一致，但「当前配置」里混进行为开关后两处一起乱。

根因：这些键进 state.json 时是逐个需求独立加的（每个决策文档各加一两个），
每个都挂在当时最顺手的位置，从未有过「行为开关归置点」的设计。

## 落法

- **一个 band 收编全部行为开关**：`BehaviorSettingsBand` 按行为对应关系分五组，
  每组 `.dt-behavior-group`（上边框分隔 + 12px 组标题）：
  - 会话行为：`defaultArchitecture`（新聊天架构）、`defaultContextMode`（AgentTavern
    上下文，仍随架构分段条件渲染，不可用原因提示保留）、`agentTavernPreloadAssets`、
    `nativeAgentPersona`；
  - 世界书行为：`worldFollowsCharacter`；
  - 工具写入：`agentTavernAllowGlobalWrites`；
  - 前端与卡脚本：`frontendAutoOpen`、`frontendAllowExternalResources`（+安全警告）、
    `cardScriptsAutoRun`（+安全警告）；
  - 游戏行为：`gamesDisableResign`。
- **第 19 个分区**：注册为 `{ id: 'behavior', group: 'system' }`，system 组置顶
  （presets 之前）——它决定插件怎么行为，是系统级配置而非资产管理。nav 图标自绘
  `IconSlidersOutline16`（三轨三钮，lucide sliders-horizontal 的 16px 比缩编；
  宿主清单无此语义图形，bind 层借名会被 `client-vm-mount` 门禁拦下）。
- **旧挂点清零**：`ActiveSetupBand` 只剩角色/预设/人设/压缩总结模型快速切换
  （「当前配置」回归本职）；世界书清单、游戏清单摘掉开关只留本职；随之删除
  不再被引用的 `.dt-architecture-settings` / `.dt-frontend-resources` 旧容器
  （前端组的警告语汇 `.dt-frontend-warning` 保留复用）。
- **双挂点保持**:`BehaviorSettingsBand` 同时挂面板分区与原生设置页
  （`TavernSettings` 内 `ActiveSetupBand` 之后），沿用既有先例；设置页此前通过
  `ActiveSetupBand` 可达的全部开关一个不丢。
- **行为不变**:所有键名、默认值、服务端逐次读取语义原样保留
  （`tavern-store` 与三个服务端 bundle 零改动）。

## 见证

- 新增 `packages/plugin/tests/behavior-settings-client.spec.ts`:分区注册位置
  （system 组置顶）、九个开关的 `applyPatch` 字面量、zh/en 键镜像 ×2、自绘图标
  在场、双挂点顺序、旧挂点负样本（`run(patchState({ worldFollowsCharacter` /
  `dt-frontend-resources` / `dt-architecture-settings` 清零）。
- `games-client.spec.ts` 的「禁用投降」开关 marker 随迁移改为
  `applyPatch({ gamesDisableResign: event.target.checked })`。
- `helper-client.spec.ts` / `card-scripts-client.spec.ts` 的 `checked:` 表达式
  字面量保持原状（band 内沿用 `bootstrap.state.*` 同款写法），零改动通过。
- 全量 `vitest run`(126 文件）与 `gates/run.mjs` 通过。

## 影响面

- 服务端（`index.mjs` / `agent.mjs` / `card-workbench.mjs` / `compaction.mjs` /
  `tavern-store`）零改动——行为键的读取方一个没动。
- Mod 追加分区（`registerPanelSection`）行为不变。
- 设置页（`settings.section` slot）内容变化：「当前配置」变纯，新增「行为设置」
  band；版本/commit 戳与更新检查按钮位置不变。
