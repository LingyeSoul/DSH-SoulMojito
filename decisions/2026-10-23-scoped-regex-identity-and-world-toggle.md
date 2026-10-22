# 卡级/预设级正则的同名识别与链接世界书面板显示

> 日期：2026-10-23。承接 `2026-10-22-card-scoped-regex-and-worlds.md`。用户反馈：管理面板的正则开关点了没反应；切换角色卡后，新卡链接的世界书不显示启用、上一张卡的世界书也不显示关闭。

## 根因（RCA）

1. **正则实体按 `scriptName` 全局合并、单归属**：两张卡都内嵌同名脚本（如「状态栏美化」）时，后导入的卡要么顶掉前一张卡的实体，要么被旧归属挡住；全局列表里最终只有一条实体，只记得一个 owner。另一张卡的脚本在面板里不可见/被锁死，点开关时 `disabled` 命中不了它，看起来就是「没反应」。运行期 `collectRegexScripts` 还能靠卡内脚本兜底，但面板与开关状态已经失真。
2. **面板把非当前来源的脚本 `disabled` 锁死**：即使识别正确，归属其他卡的脚本开关也是 disabled，点击没有任何回执。
3. **世界书勾选只渲染手动 `activeWorlds`**：链接书由生成面自动并入，从不写手动列表。旧版本切卡时曾把链接书写进 `activeWorlds`，于是换卡后旧书残留勾选、新卡链接书永远不勾选。

## 决策

- **正则实体按来源拆分**：`applySourceRegexScripts` 以 `(scriptName, 来源)` 复用/新建实体；同名跨卡、跨预设各持一条独立 id，`regexScriptOwners` / `regexScriptPresetOwners` 继续按 id 记录归属。导入、回填、面板全量替换都走同一套。
- **一次性迁移**：`TavernState.regexOwnershipVersion = 2`。`ensureRegexScriptOwners` 在版本 < 2 时扫描全部角色卡/预设，为每个来源补齐实体；无同名的全局脚本仍按旧语义认领（全局优先），之后不再扫描。
- **面板开关不再锁死**：归属其他来源的脚本仍置灰，但可以切换（保存脚本自身 `disabled`），并在切换时给「只在某卡/某预设会话生效」的回执。每行新增「全局」按钮：换一个新 id 保存，服务端剪掉旧归属，脚本转为全局。
- **世界书显示实际生效状态**：链接到当前角色卡的世界书自动勾选并带「自动」徽标；取消勾选写入 `TavernState.disabledAutoWorlds`，生成面跳过该书且不回落到卡内嵌书。手动 `activeWorlds` 仍优先，且插件仍不把链接书写入手动列表。
- **切卡清理残留**：`activeCharacterPatch` 在切换活跃角色卡（面板或会话绑定）时，把上一张卡链接书在 `activeWorlds` 里的残留条目移除，避免旧版本污染继续显示。

## 边界

- 同名「全局」脚本与卡脚本共存时，全局仍优先（与 2026-10-22 决策一致）；迁移期按旧语义认领无归属条目，日常导入只接管同 id 同名的无归属条目，不再按名称抢走用户全局脚本。
- 群组会话不在此次范围：链接书与卡级正则仍按当前单角色语义处理。
- `activeWorlds` 仍然只代表用户手动选择；链接书不写入，只由 `disabledAutoWorlds` 表达「这次不自动启用」。
- 迁移会为本来源新增实体（旧数据里被顶掉的同名脚本会重新出现），这是修复识别问题的必要代价。

## 验证

- `packages/tavern-store/tests/store.spec.ts`：同名跨卡导入各持一条；重导入只更新本卡；旧 state 单归属迁移拆分；幂等。
- `packages/plugin/tests/tavern-assets.spec.ts`：同名跨卡生效集各取自己那条；`disabledAutoWorlds` 停用链接书且不回落内嵌书；手动 `activeWorlds` 优先。
- `packages/plugin/tests/tavern-command.spec.ts`：切卡清掉旧卡链接书残留；`disabledAutoWorlds` 路由可写。
- `pnpm run check`：2014 项测试 + 18 项 gates PASS。