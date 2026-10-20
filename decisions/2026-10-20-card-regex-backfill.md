# 存量角色卡正则脚本回填（从角色卡同步）

日期：2026-10-20。状态：已实施。相关：`packages/tavern-store/src/store.ts`（`backfillRegexScriptsFromCharacters`）、`packages/plugin/src/http/router.ts`（`POST regex/sync-cards`）、`packages/plugin/client-src/81-ui-regex.js`（RegexBand）。

## Problem

卡内嵌 `data.extensions.regex_scripts` 的导入期自动物化（`importCharacter` → `importEmbeddedRegex` → `importRegexScripts`）在 2026-09-04 才落地。此前导入的角色卡虽然卡文件里仍带着正则脚本，但 `state.json` 的全局表里没有对应条目，面板里看不到、生成时也不会应用。

同时 `parseRegexScripts` 是整批原子语义：只要卡里有一条脚本缺 `findRegex`，整张卡的脚本都会被跳过。直接让用户「重新导入一次卡」既会重写世界书链接，也无法容忍这种坏条目。

## Decision

在正则面板增加「从角色卡同步」入口，服务端一次性扫描存量卡并回填**缺失**的脚本：

- **只补缺不覆盖**：以 `scriptName` 为键，全局表已有的名字原样保留（用户可能已经改过），卡内同名脚本计入 `skipped`。
- **跨卡去重**：按 `listCharacters()` 的排序扫描，同名脚本先到先得，后到的计入 `skipped`。
- **逐条容错**：新增 `listRegexScriptEntries`（tavern-format）只负责展开容器形态，回填循环对每条 `parseRegexScript` 单独 try/catch；非法条目计入 `invalid`，不影响同卡其他脚本。
- **一次写盘**：扫描全部卡后调用一次 `updateState`，并在写回调里按当时状态再过滤一次同名，避免与并发导入重复追加。
- **计数回执**：返回 `{ imported, skipped, invalid, scanned }`，面板显示「已扫描 N 张角色卡：新增 X，跳过 Y，格式非法 Z」。重复点击保持幂等（新增 0）。
- **入口与路由**：`POST regex/sync-cards` 加入 `REQUIRED_SERVER_ROUTES`；客户端 `syncRegexScriptsFromCards()` 直接复用响应里的 `scripts` 更新 bootstrap，不额外拉取。

## Alternatives considered

- **重导所有卡**：会重写卡文件、世界书链接和活动状态，且无法逐条容错；对「只缺正则」的问题过重。拒绝。
- **客户端逐卡 GET `character/:name` 再 PUT `regex`**：N 次往返、解析规则散落到 UI，且一次请求失败会留下半同步状态。拒绝。
- **复用 `importRegexScripts` 的合并语义**：同名即覆盖，会把用户已编辑的全局脚本回退成卡内旧版本。拒绝。
- **让导入期自动物化改成逐条容错**：会改变现有「整卡脚本要么全导入要么跳过」的原子语义，影响导入回执 `importedRegex` 的含义；回填是独立路径，保持导入语义不变。拒绝。

## Consequences

- 旧卡不需要重新导入即可补齐正则；面板按钮可反复执行，结果稳定。
- 卡文件不会被写回，角色/世界书/聊天数据零改动；只有 `state.json` 的 `regexScripts` 追加缺失项。
- 导入期自动物化仍是正常路径；本功能只处理历史存量与自动物化失败后残留的卡。
- `listRegexScriptEntries` 同时收敛了 `parseRegexScripts` 的容器展开逻辑，后续按条解析不必复制形状判断。
- 覆盖：`packages/tavern-store/tests/store.spec.ts`（缺省补齐、同名跳过、跨卡去重、非法单条、幂等）与 `packages/plugin/tests/tavern-command.spec.ts`（路由回执与全局版本保留）。
