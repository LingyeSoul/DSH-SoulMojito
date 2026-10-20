# 预设内嵌正则脚本的导入期物化与存量回填

日期：2026-10-20。状态：已实施。相关：`packages/tavern-store/src/store.ts`（`importPreset`、`backfillRegexScriptsFromPresets`）、`packages/plugin/src/http/router.ts`（`POST import/preset`、`POST regex/sync-presets`）、`packages/plugin/client-src/81-ui-regex.js`（RegexBand）。

## Problem

SillyTavern 的预设可以携带 preset-scoped 正则脚本，落盘位置是 `preset.extensions.regex_scripts`（ST `regex/engine.js` 通过 `readPresetExtensionField({ path: 'regex_scripts' })` 读取）。此前本项目的 `POST import/preset` 只调用 `putPreset` 原样保存 JSON，脚本一直留在预设文件里，没有进入 `state.json` 的全局 `regexScripts`：面板看不到，生成时也不会应用。

角色卡的内嵌正则已在导入期物化，但预设路径漏了这一步；同时旧版本导入的预设也不会因为新逻辑上线而自动补齐。

## Decision

**导入期物化**：`importPreset(name, preset)` 在 `putPreset` 之后读取 `preset.extensions.regex_scripts`，复用 `importRegexScripts` 按 `scriptName` 合并进全局表，返回 `{ importedRegex }`；`POST import/preset` 把该计数透传给客户端。物化失败（整批格式非法）只让 `importedRegex` 为 0，不阻断预设落盘——与角色卡内嵌脚本的「导入成功、脚本跳过」语义一致。

**存量回填**：新增 `backfillRegexScriptsFromPresets` 与 `POST regex/sync-presets`，正则面板增加「从预设同步」。它与角色卡回填共用 `stageRegexBackfillEntries` / `commitRegexBackfill`：

- 只补全局表缺少的 `scriptName`，已存在的脚本保持用户当前版本；
- 按 `listPresets()` 排序扫描，跨预设重名先到先得；
- 单条非法只计入 `invalid`，不影响同预设其他条目；
- 全部扫描完只写一次 `state.json`，写回调里再次按当前状态过滤同名；
- 回执 `{ imported, skipped, invalid, scanned }`，重复执行幂等。

**不改 PUT 路径**：`PUT preset/:name` 是面板每次保存都会走的编辑路径。若在那里物化，用户改完预设保存一次就会用文件里的旧脚本覆盖全局表里已经编辑过的版本。

## Alternatives considered

- **运行时按 activePreset 合并脚本**：要在每次生成/展示时动态读取预设文件并合并，正则解析散落到请求热路径；面板也无法编辑这些「临时脚本」。拒绝。
- **PUT 时也物化**：面板保存会反复覆盖用户已编辑的全局脚本，且把「保存预设」和「导入预设」变成两种不同语义。拒绝。
- **要求用户重新导入预设**：会覆盖同名预设，且旧版本导入的存量预设无法被发现。拒绝。
- **回填走 `importRegexScripts` 的覆盖合并**：会把用户改过的全局脚本回退成预设里的旧版本。拒绝。

## Consequences

- 新导入的预设立即拥有可用脚本；旧预设通过一次「从预设同步」补齐，无需重新导入。
- 预设文件保持原样（`extensions.regex_scripts` 不被移除），导出后仍可回到 ST 使用。
- 全局表是唯一运行态来源；预设后续变更不会自动同步，需要用户再次导入或点同步——与角色卡的行为一致。
- 角色卡与预设回填共享同一套暂存/收口逻辑，计数语义（含并发导入时的晚到重名跳过）保持一致。
- 覆盖：`packages/tavern-store/tests/store.spec.ts`（导入物化、非法批次不阻断、存量回填计数、跨预设去重、幂等）与 `packages/plugin/tests/tavern-command.spec.ts`（导入路由回执、`regex/sync-presets` 回执与效果）。
